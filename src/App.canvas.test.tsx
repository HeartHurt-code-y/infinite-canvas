import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as videoFrameSampler from "./lib/videoFrameSampler";
import type {
  CloudAsset,
  GenerationTaskDetail,
  GenerationTaskSummary,
  MediaReferenceTarget,
  SaveCanvasDocumentCommand,
} from "./lib/backend";
import { defaultModelOperationSchema } from "./lib/modelCapabilities";
import type { PromptContentDocumentV1 } from "./lib/promptContent";
import type { CanvasDocumentV2 } from "./features/canvas/canvasStore";
import type { VideoLocalEditDialogProps } from "./features/workspace/VideoLocalEditDialog";
import { fireCanvasMouse } from "./test/canvasEvents";

const {
  dialogOpenMock,
  dialogSaveMock,
  fileStatMock,
  writeTextFileMock,
  videoLocalEditSourceMock,
  videoLocalEditInstructionMock,
} = vi.hoisted(() => {
  // 标注弹窗提交的编辑要求文档；用例可替换为含 @ 引用的版本来覆盖连线校验。
  const videoLocalEditInstructionMock: { document: PromptContentDocumentV1 } = {
    document: {
      schema: "prompt-content",
      version: 1,
      items: [{ kind: "text", text: "删除标记区域中的路人" }],
    },
  };
  return {
    dialogOpenMock: vi.fn(),
    dialogSaveMock: vi.fn(),
    fileStatMock: vi.fn(),
    writeTextFileMock: vi.fn(),
    videoLocalEditSourceMock: vi.fn(),
    videoLocalEditInstructionMock,
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenMock,
  save: dialogSaveMock,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: fileStatMock,
  writeTextFile: writeTextFileMock,
}));

// Drawing interactions are exercised by the dialog tests; this boundary checks canvas persistence and IPC.
// 与真实弹窗一致：提交失败把错误显示出来，而不是把 rejection 丢成未处理错误。
vi.mock("./features/workspace/VideoLocalEditDialog", () => ({
  VideoLocalEditDialog: ({ source, onApply }: VideoLocalEditDialogProps) => {
    videoLocalEditSourceMock(source);
    const [error, setError] = useState<string | null>(null);
    return (
      <>
        <button
          type="button"
          onClick={() =>
            void onApply({
              imageDataUrl: "data:image/png;base64,c2FtcGxl",
              timeSeconds: 2.25,
              instructionDocument: videoLocalEditInstructionMock.document,
              operation: "remove",
              sourceKey: source.key,
              uploadFrameToLibrary: false,
              timeRange: null,
            }).catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            )
          }
        >
          应用测试局部标注 · {source.label}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </>
    );
  },
}));

// 桌面运行时 mock：@tauri-apps/api 的 invoke / listen 都会走到这里。
const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const mediaPlayMock = vi.fn<() => Promise<void>>();
const mediaPauseMock = vi.fn<() => void>();
const tauriCallbacks = new Map<number, (payload: unknown) => unknown>();
let nextTauriCallbackId = 1;

const PROVIDER = {
  id: "moyu-production",
  displayName: "Moyu 生产",
  adapterId: "moyu_v1",
  baseUrl: "https://api.example.com",
  apiKeyRef: "moyu-key",
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const SECOND_PROVIDER = {
  id: "luma-production",
  displayName: "Luma 生产",
  adapterId: "luma_v1",
  baseUrl: "https://luma.example.com",
  apiKeyRef: "luma-key",
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const IMAGE_MODEL = {
  id: "gpt-image-2",
  displayName: "GPT Image 2",
  remoteModelId: "gpt-image-2",
  operations: defaultModelOperationSchema("gpt-image-2", ["text_to_image", "image_to_image"]),
  createdAt: 0,
  updatedAt: 0,
};

const ALT_IMAGE_MODEL = {
  id: "gpt-image-2-fast",
  displayName: "GPT Image 2 Fast",
  remoteModelId: "gpt-image-2-fast",
  operations: defaultModelOperationSchema("gpt-image-2-fast", ["text_to_image", "image_to_image"]),
  createdAt: 0,
  updatedAt: 0,
};

const TEXT_ONLY_IMAGE_MODEL = {
  id: "gpt-image-text-only",
  displayName: "GPT Image Text Only",
  remoteModelId: "gpt-image-text-only",
  operations: defaultModelOperationSchema("gpt-image-text-only", ["text_to_image"]),
  createdAt: 0,
  updatedAt: 0,
};

const SECOND_IMAGE_MODEL = {
  id: "photon-1",
  displayName: "Photon 1",
  remoteModelId: "photon-1",
  operations: defaultModelOperationSchema("photon-1", ["text_to_image", "image_to_image"]),
  createdAt: 0,
  updatedAt: 0,
};

const VIDEO_MODEL = {
  id: "doubao-seedance-2-5-260628",
  displayName: "Seedance 2.5",
  remoteModelId: "doubao-seedance-2-5-260628",
  operations: defaultModelOperationSchema("doubao-seedance-2-5-260628", ["video_generation"]),
  createdAt: 0,
  updatedAt: 0,
};

const ALT_VIDEO_MODEL = {
  id: "doubao-seedance-2-5-lite",
  displayName: "Seedance 2.5 Lite",
  remoteModelId: "doubao-seedance-2-5-lite",
  operations: defaultModelOperationSchema("doubao-seedance-2-5-lite", ["video_generation"]),
  createdAt: 0,
  updatedAt: 0,
};

const FAST_VIDEO_MODEL = {
  id: "doubao-seedance-2-0-fast-260128",
  displayName: "Seedance 2.0 Fast",
  remoteModelId: "doubao-seedance-2-0-fast-260128",
  operations: defaultModelOperationSchema("doubao-seedance-2-0-fast-260128", ["video_generation"]),
  createdAt: 0,
  updatedAt: 0,
};

const TEXT_MODEL = {
  id: "doubao-seed-1-8-251228",
  displayName: "Seed 1.8 文本模型",
  remoteModelId: "doubao-seed-1-8-251228",
  operations: defaultModelOperationSchema("doubao-seed-1-8-251228", ["text_generation"]),
  createdAt: 0,
  updatedAt: 0,
};

// 模拟用户升级前已经保存的 Wan 绑定：模型身份正确，但历史能力快照仍是空参数。
const STALE_WAN_VIDEO_MODEL = {
  id: "remote::moyu-production::wan3.0-video",
  displayName: "wan3.0-video",
  remoteModelId: "wan3.0-video",
  operations: {
    video_generation: {
      resultType: "video",
      requestProfileId: "moyu_video_metadata_v1",
      profileVersion: 1,
      request: {
        path: "/v1/video/generations",
        encoding: "json",
        parameterContainer: "metadata",
      },
      parameters: {},
    },
  },
  createdAt: 0,
  updatedAt: 0,
};

const SECOND_VIDEO_MODEL = {
  id: "ray-2",
  displayName: "Ray 2",
  remoteModelId: "ray-2",
  operations: {
    video_generation: {
      resultType: "video",
      parameters: {
        ratio: {
          type: "string",
          default: "adaptive",
          enum: ["16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"],
        },
        resolution: {
          type: "string",
          default: "720p",
          enum: ["720p", "1080p"],
        },
        duration: { type: "integer", default: 8, enum: [5, 8, 12] },
        generate_audio: { type: "boolean", default: true },
      },
    },
  },
  createdAt: 0,
  updatedAt: 0,
};

const IMAGE_BINDING = {
  providerConnectionId: "moyu-production",
  modelDefinitionId: "gpt-image-2",
  tokenGroup: null,
  enabledOperations: ["text_to_image", "image_to_image"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const ALT_IMAGE_BINDING = {
  providerConnectionId: "moyu-production",
  modelDefinitionId: "gpt-image-2-fast",
  tokenGroup: null,
  enabledOperations: ["text_to_image", "image_to_image"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const TEXT_ONLY_IMAGE_BINDING = {
  providerConnectionId: "moyu-production",
  modelDefinitionId: "gpt-image-text-only",
  tokenGroup: null,
  enabledOperations: ["text_to_image"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const SECOND_PROVIDER_IMAGE_BINDING = {
  providerConnectionId: "luma-production",
  modelDefinitionId: "gpt-image-2",
  tokenGroup: null,
  enabledOperations: ["text_to_image", "image_to_image"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const SECOND_PROVIDER_ALT_IMAGE_BINDING = {
  providerConnectionId: "luma-production",
  modelDefinitionId: "photon-1",
  tokenGroup: null,
  enabledOperations: ["text_to_image", "image_to_image"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const VIDEO_BINDING = {
  providerConnectionId: "moyu-production",
  modelDefinitionId: "doubao-seedance-2-5-260628",
  tokenGroup: null,
  enabledOperations: ["video_generation"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const ALT_VIDEO_BINDING = {
  providerConnectionId: "moyu-production",
  modelDefinitionId: "doubao-seedance-2-5-lite",
  tokenGroup: null,
  enabledOperations: ["video_generation"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const FAST_VIDEO_BINDING = {
  providerConnectionId: "moyu-production",
  modelDefinitionId: "doubao-seedance-2-0-fast-260128",
  tokenGroup: null,
  enabledOperations: ["video_generation"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const STALE_WAN_VIDEO_BINDING = {
  providerConnectionId: "moyu-production",
  modelDefinitionId: STALE_WAN_VIDEO_MODEL.id,
  tokenGroup: null,
  enabledOperations: ["video_generation"],
  remoteModelId: "wan3.0-video",
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const SECOND_PROVIDER_VIDEO_BINDING = {
  providerConnectionId: "luma-production",
  modelDefinitionId: "doubao-seedance-2-5-260628",
  tokenGroup: null,
  enabledOperations: ["video_generation"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const SECOND_PROVIDER_ALT_VIDEO_BINDING = {
  providerConnectionId: "luma-production",
  modelDefinitionId: "ray-2",
  tokenGroup: null,
  enabledOperations: ["video_generation"],
  remoteModelId: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const CLOUD_ASSETS: readonly CloudAsset[] = [
  {
    providerConnectionId: PROVIDER.id,
    id: "asset-image-1",
    kind: "image",
    name: "站台参考图",
    status: "ready",
    rawStatus: "Active",
    previewUrl: "https://cdn.example.com/station.jpg",
    assetUrl: "https://cdn.example.com/station.jpg",
    coverUrl: null,
    groupId: null,
  },
  {
    providerConnectionId: PROVIDER.id,
    id: "asset-video-1",
    kind: "video",
    name: "列车进站参考",
    status: "ready",
    rawStatus: "Active",
    previewUrl: "https://cdn.example.com/train.mp4",
    assetUrl: "https://cdn.example.com/train.mp4",
    coverUrl: "https://cdn.example.com/train-keyframe.jpg",
    groupId: null,
  },
  {
    providerConnectionId: PROVIDER.id,
    id: "asset-video-2",
    kind: "video",
    name: "衣摆运动参考",
    status: "ready",
    rawStatus: "Active",
    previewUrl: "https://cdn.example.com/hem.mp4",
    assetUrl: "https://cdn.example.com/hem.mp4",
    coverUrl: null,
    groupId: null,
  },
];

/** 构造任务摘要（产物卡片按任务列表实时状态渲染）。 */
function makeTaskSummary(overrides: Partial<GenerationTaskSummary> = {}): GenerationTaskSummary {
  return {
    id: "task-1",
    canvasId: "canvas-scene-03",
    sourceNodeId: "gen-node-1",
    operation: "video_generation",
    status: "running",
    queryHealth: "healthy",
    providerConnectionId: PROVIDER.id,
    providerDisplayNameSnapshot: PROVIDER.displayName,
    modelDefinitionId: VIDEO_MODEL.id,
    remoteModelIdSnapshot: VIDEO_MODEL.remoteModelId,
    remoteTaskId: "remote-task-1",
    progress: null,
    tokens: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  };
}

function setupDesktopRuntime(): void {
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {
    invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
    transformCallback: (callback: (payload: unknown) => unknown) => {
      const id = nextTauriCallbackId++;
      tauriCallbacks.set(id, callback);
      return id;
    },
    convertFileSrc: (filePath: string) => `asset://localhost/${encodeURIComponent(filePath)}`,
    metadata: { currentWindow: { label: "main" } },
  };
  // @tauri-apps/api v2.11 的事件反注册依赖该内部对象。
  (window as unknown as Record<string, unknown>)["__TAURI_EVENT_PLUGIN_INTERNALS__"] = {
    unregisterListener: () => undefined,
  };
}

const ASSET_NODE_WIDTH = 500;
const ASSET_NODE_HEIGHT = 437.5;

function getCanvasViewport(): HTMLElement {
  const viewport = document.querySelector<HTMLElement>(".canvas-viewport");
  expect(viewport).not.toBeNull();
  return viewport!;
}

/** 指针事件模拟拖拽：pointerDown → pointerMove（越过阈值激活）→ pointerUp 落点。 */
function dragToCanvas(source: HTMLElement, clientX: number, clientY: number): void {
  // 无限画布：落点判定与坐标换算都基于视口 rect，mock 一个 1280×800 的视口。
  const viewport = getCanvasViewport();
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
    clientX,
    clientY,
  });
}

/** 节点内容的 React Flow 包装层（节点位置由包装层 transform 表达）。 */
function rfWrapperOf(nodeContent: HTMLElement): HTMLElement {
  const wrapper = nodeContent.closest<HTMLElement>(".react-flow__node");
  expect(wrapper).not.toBeNull();
  return wrapper!;
}

/** 节点在画布坐标系中的位置（包装层 transform 的 translate 值）。 */
function rfNodeFlowPosition(nodeContent: HTMLElement): { x: number; y: number } {
  const transform = rfWrapperOf(nodeContent).style.transform;
  const match = transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
  expect(match).not.toBeNull();
  return { x: Number.parseFloat(match![1]!), y: Number.parseFloat(match![2]!) };
}

/** 画布坐标 → client 坐标（平移与缩放都取实时视口 transform）。 */
function clientFromFlow(x: number, y: number): { clientX: number; clientY: number } {
  const transform =
    document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
  const match = transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/);
  const panX = match ? Number.parseFloat(match[1]!) : 0;
  const panY = match ? Number.parseFloat(match[2]!) : 0;
  const zoom = match ? Number.parseFloat(match[3]!) : 1;
  return { clientX: x * zoom + panX, clientY: y * zoom + panY };
}

/** 等待 RF 完成节点测量（wrapper 由 visibility: hidden 转为 visible），随后角色查询才可靠。 */
async function waitForNodeAccessible(nodeContent: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(rfWrapperOf(nodeContent)).toHaveStyle({ visibility: "visible" });
  });
  return nodeContent;
}

/**
 * 通过 RF 拖拽把手拖动节点（d3-drag 语义：mousedown 把手 → window mousemove/mouseup），
 * 返回拖动前后节点的画布坐标。
 */
function dragNodeViaHandle(
  nodeContent: HTMLElement,
  handleSelector: string,
  flowDx: number,
  flowDy: number,
): { before: { x: number; y: number }; after: { x: number; y: number } } {
  const handle = nodeContent.querySelector<HTMLElement>(handleSelector);
  expect(handle).not.toBeNull();
  const before = rfNodeFlowPosition(nodeContent);
  // d3-drag 会读取 event.view（jsdom 默认 null 会抛错）；手动构造事件并覆写 view。
  fireCanvasMouse(handle!, "mousedown", clientFromFlow(before.x, before.y));
  // RF 拖拽在越过阈值的首段 move 上只记录抓取偏移、不更新位置；
  // 节点最终位移 = 末段 move − 首段 move，故首段只越过阈值（+2px），末段位移加同一偏移。
  fireCanvasMouse(document, "mousemove", clientFromFlow(before.x + 2, before.y + 2));
  fireCanvasMouse(
    document,
    "mousemove",
    clientFromFlow(before.x + flowDx + 2, before.y + flowDy + 2),
  );
  fireCanvasMouse(
    document,
    "mouseup",
    clientFromFlow(before.x + flowDx + 2, before.y + flowDy + 2),
  );
  return { before, after: rfNodeFlowPosition(nodeContent) };
}

/** 通过 RF 连线把手连接两个节点（mousedown 源 handle → window mousemove → mouseup 目标位置）。 */
function connectViaHandles(
  sourceNode: HTMLElement,
  targetNode: HTMLElement,
  targetOffset: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): void {
  const sourceHandle = rfWrapperOf(sourceNode).querySelector<HTMLElement>(
    ".react-flow__handle.source",
  );
  expect(sourceHandle).not.toBeNull();
  const from = rfNodeFlowPosition(sourceNode);
  const to = rfNodeFlowPosition(targetNode);
  // RF Handle 把连线流程绑在 onMouseDown 上，后续 move/up 由其内部挂到 window；
  // 连线阈值逻辑会在首段 move 上只记录状态，需末段 move 才能完成命中。
  fireCanvasMouse(sourceHandle!, "mousedown", clientFromFlow(from.x, from.y));
  fireCanvasMouse(document, "mousemove", clientFromFlow(from.x + 2, from.y + 2));
  const dropPoint = clientFromFlow(to.x + targetOffset.x, to.y + targetOffset.y);
  fireCanvasMouse(document, "mousemove", dropPoint);
  fireCanvasMouse(document, "mouseup", dropPoint);
}

/** 从真实端口拖到指定落点，让 mouseup 的 DOM target 区分画布空白与节点本体。 */
function dropConnectionFromHandle(
  node: HTMLElement,
  handleType: "source" | "target",
  dropTarget: Element,
  flowPoint: { x: number; y: number },
): void {
  const handle = rfWrapperOf(node).querySelector<HTMLElement>(`.react-flow__handle.${handleType}`);
  expect(handle).not.toBeNull();
  const from = rfNodeFlowPosition(node);
  fireCanvasMouse(handle!, "mousedown", clientFromFlow(from.x, from.y));
  fireCanvasMouse(document, "mousemove", clientFromFlow(from.x + 2, from.y + 2));
  const dropPoint = clientFromFlow(flowPoint.x, flowPoint.y);
  fireCanvasMouse(document, "mousemove", dropPoint);
  fireCanvasMouse(dropTarget, "mouseup", dropPoint);
}

async function addGenerationNode(
  kind: "图片" | "视频",
  clientX: number,
  clientY: number,
): Promise<HTMLElement> {
  const selector = `.canvas-gen-node--${kind === "图片" ? "image" : "video"}`;
  const countBefore = document.querySelectorAll(selector).length;
  const template = screen.getByRole("button", { name: `拖拽创建${kind}生成节点` });
  dragToCanvas(template, clientX, clientY);

  await waitFor(() => {
    expect(document.querySelectorAll(selector)).toHaveLength(countBefore + 1);
  });
  return waitForNodeAccessible(
    Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!,
  );
}

async function addPromptNode(clientX: number, clientY: number): Promise<HTMLElement> {
  const selector = ".canvas-gen-node--prompt";
  const countBefore = document.querySelectorAll(selector).length;
  dragToCanvas(
    screen.getByRole("button", { name: "拖拽创建提示词生成与优化节点" }),
    clientX,
    clientY,
  );
  await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(countBefore + 1));
  return waitForNodeAccessible(
    Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!,
  );
}

async function addScreenplayNode(clientX: number, clientY: number): Promise<HTMLElement> {
  const selector = ".canvas-screenplay-node";
  const countBefore = document.querySelectorAll(selector).length;
  dragToCanvas(
    screen.getByRole("button", { name: "拖拽创建剧本创作与优化节点" }),
    clientX,
    clientY,
  );
  await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(countBefore + 1));
  return waitForNodeAccessible(
    Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!,
  );
}

async function addStoryboardNode(clientX: number, clientY: number): Promise<HTMLElement> {
  const selector = ".canvas-screenplay-node--storyboard";
  const countBefore = document.querySelectorAll(selector).length;
  dragToCanvas(
    screen.getByRole("button", { name: "拖拽创建剧本转工业级分镜脚本节点" }),
    clientX,
    clientY,
  );
  await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(countBefore + 1));
  return waitForNodeAccessible(
    Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!,
  );
}

/**
 * 取文档区 Markdown 编辑框：文档区默认是「预览」渲染，读取/编辑前先切到「编辑」视图，
 * 再按 aria-label 定位 textarea。
 */
function getDocumentEditor(node: HTMLElement, name: string): HTMLTextAreaElement {
  const editToggle = within(node).getByRole("button", { name: "编辑" });
  if (editToggle.getAttribute("aria-pressed") !== "true") {
    fireEvent.click(editToggle);
  }
  return within(node).getByRole("textbox", { name });
}

async function addViralRemixNode(clientX: number, clientY: number): Promise<HTMLElement> {
  const selector = ".canvas-screenplay-node--viral_remix";
  const countBefore = document.querySelectorAll(selector).length;
  dragToCanvas(screen.getByRole("button", { name: "拖拽创建爆款视频复刻节点" }), clientX, clientY);
  await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(countBefore + 1));
  return waitForNodeAccessible(
    Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!,
  );
}

async function addVideoComposerNode(clientX: number, clientY: number): Promise<HTMLElement> {
  const selector = ".canvas-video-composer";
  const countBefore = document.querySelectorAll(selector).length;
  dragToCanvas(
    screen.getByRole("button", { name: "拖拽创建视频拼接与合成节点" }),
    clientX,
    clientY,
  );
  await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(countBefore + 1));
  return waitForNodeAccessible(
    Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!,
  );
}

async function addVideoDownloaderNode(clientX: number, clientY: number): Promise<HTMLElement> {
  const selector = ".canvas-video-downloader";
  const countBefore = document.querySelectorAll(selector).length;
  dragToCanvas(
    screen.getByRole("button", { name: "拖拽创建网络爆款视频下载节点" }),
    clientX,
    clientY,
  );
  await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(countBefore + 1));
  return waitForNodeAccessible(
    Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!,
  );
}

async function addFrameExtractorNode(clientX: number, clientY: number): Promise<HTMLElement> {
  const selector = ".canvas-video-frame-extractor";
  const countBefore = document.querySelectorAll(selector).length;
  dragToCanvas(screen.getByRole("button", { name: "拖拽创建视频抽帧节点" }), clientX, clientY);
  await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(countBefore + 1));
  return waitForNodeAccessible(
    Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!,
  );
}

function connectPromptToGeneration(promptNode: HTMLElement, generationNode: HTMLElement): void {
  connectViaHandles(promptNode, generationNode);
}

async function addAssetNode(
  kind: "图片" | "视频" | "音频",
  name: string,
  clientX: number,
  clientY: number,
): Promise<HTMLElement> {
  // 云端分页查询不提供类型计数，Tab 可能不带角标（本地来源带角标）。
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${kind}( \\d+)?$`) }));
  const card = await screen.findByRole("button", {
    name: `预览${kind}素材详情：${name}`,
  });
  // 生成产物占位卡片复用 .canvas-asset-node 样式，这里只统计真正的素材节点。
  const selector = ".canvas-asset-node:not(.canvas-asset-node--output)";
  const countBefore = document.querySelectorAll(selector).length;
  dragToCanvas(card, clientX, clientY);

  await waitFor(
    () => {
      expect(document.querySelectorAll(selector)).toHaveLength(countBefore + 1);
    },
    { timeout: 5_000 },
  );
  return waitForNodeAccessible(
    Array.from(document.querySelectorAll<HTMLElement>(selector)).at(-1)!,
  );
}

async function addWorkflowNode(buttonName = "添加工作流节点"): Promise<HTMLElement> {
  const repositoryToggle = screen.getByRole("button", { name: /工作流仓库/ });
  if (repositoryToggle.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(repositoryToggle);
  }
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  const workflow = await waitFor(() => {
    const node = document.querySelector<HTMLElement>(".canvas-knowledge-workflow");
    expect(node).not.toBeNull();
    return node!;
  });
  return waitForNodeAccessible(workflow);
}

function expectNodesNotToOverlap(
  first: HTMLElement,
  firstSize: { width: number; height: number },
  second: HTMLElement,
  secondSize: { width: number; height: number },
): void {
  const firstPos = rfNodeFlowPosition(first);
  const secondPos = rfNodeFlowPosition(second);
  const firstX = firstPos.x;
  const firstY = firstPos.y;
  const secondX = secondPos.x;
  const secondY = secondPos.y;
  expect(
    firstX + firstSize.width <= secondX ||
      secondX + secondSize.width <= firstX ||
      firstY + firstSize.height <= secondY ||
      secondY + secondSize.height <= firstY,
  ).toBe(true);
}

function connectAssetToGeneration(assetNode: HTMLElement, generationNode: HTMLElement): void {
  connectViaHandles(assetNode, generationNode);
}

function connectDownloaderToRemix(downloaderNode: HTMLElement, remixNode: HTMLElement): void {
  connectViaHandles(downloaderNode, remixNode);
}

function placeCaretAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function setPromptText(input: HTMLElement, text: string): void {
  const paragraph = input.querySelector<HTMLElement>(":scope > p");
  const target = paragraph ?? input;
  target.replaceChildren(document.createTextNode(text));
  placeCaretAtEnd(target);
  fireEvent.input(input);
}

function appendPromptText(input: HTMLElement, text: string): void {
  const paragraph = input.querySelector<HTMLElement>(":scope > p:last-child");
  const target = paragraph ?? input;
  const trailingBreak = target.querySelector<HTMLElement>(":scope > br.ProseMirror-trailingBreak");
  target.insertBefore(document.createTextNode(text), trailingBreak);
  placeCaretAtEnd(target);
  fireEvent.input(input);
}

/** 提示词节点的输出框是 contenteditable div，通过 aria-labelledby 关联「输出提示词」label。 */
function getPromptOutputEditor(container: HTMLElement): HTMLElement {
  const label = within(container).getByText("输出提示词", { selector: "label" });
  const htmlFor = label.getAttribute("for");
  if (htmlFor) {
    const editor = container.querySelector<HTMLElement>(`[aria-labelledby="${htmlFor}"]`);
    if (editor) return editor;
  }
  return container.querySelector<HTMLElement>("[contenteditable='true']")!;
}

function setPromptOutputText(container: HTMLElement, text: string): void {
  setPromptText(getPromptOutputEditor(container), text);
}

/** tiptap 编辑器把换行渲染为块级标签，textContent 不保留 \n，断言前需去除。 */
function noNewlines(text: string): string {
  return text.replace(/\n/g, "");
}

async function insertMention(generationNode: HTMLElement, name: string): Promise<void> {
  const input = within(generationNode).getByRole("textbox", {
    name: "提示词输入框，输入 @ 引用素材",
  });
  placeCaretAtEnd(input);
  fireEvent.click(within(generationNode).getByRole("button", { name: /引用素材到提示词/ }));
  const menu = await screen.findByRole("listbox", { name: "素材引用候选" });
  fireEvent.click(within(menu).getByRole("option", { name: new RegExp(name) }));
  expect(
    within(generationNode).getByText(`@${name}`, { exact: false, selector: ".mention-chip" }),
  ).toBeInTheDocument();
}

function submittedGenerationCommand(): Record<string, unknown> {
  const commands = submittedGenerationCommands();
  expect(commands).not.toHaveLength(0);
  return commands[0]!;
}

function submittedGenerationCommands(): Record<string, unknown>[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === "start_generation")
    .map(([, args]) => (args as { command: Record<string, unknown> }).command);
}

/** 默认 invoke mock：单测可用 mockImplementation 包装并按需覆盖个别命令。 */
/** 素材库分组 mock：创建分组后会被 refresh 拉回，贴近真实服务器行为。 */
let mockAssetGroups: Array<{
  id: string;
  name: string;
  groupName: string;
  isDefault: boolean;
  assetCount: number;
}> = [
  { id: "0", name: "默认分组", groupName: "默认分组", isDefault: true, assetCount: 0 },
  { id: "21", name: "客户案例", groupName: "客户案例", isDefault: false, assetCount: 3 },
];

function baseInvokeImplementation(
  command: string,
  args: Record<string, unknown> | undefined = invokeMock.mock.calls.at(-1)?.[1],
): Promise<unknown> {
  switch (command) {
    case "list_canvas_documents":
      return Promise.resolve([]);
    case "get_canvas_document":
      return Promise.reject(
        Object.assign(new Error("canvas document does not exist"), { kind: "not_found" }),
      );
    case "save_canvas_document": {
      const saved = args?.["command"] as SaveCanvasDocumentCommand;
      return Promise.resolve({ ...saved, revision: 1, createdAt: 1, updatedAt: 1 });
    }
    case "list_provider_connections":
      return Promise.resolve([PROVIDER, SECOND_PROVIDER]);
    case "list_model_definitions":
      return Promise.resolve([
        IMAGE_MODEL,
        ALT_IMAGE_MODEL,
        TEXT_ONLY_IMAGE_MODEL,
        SECOND_IMAGE_MODEL,
        VIDEO_MODEL,
        ALT_VIDEO_MODEL,
        FAST_VIDEO_MODEL,
        SECOND_VIDEO_MODEL,
        TEXT_MODEL,
      ]);
    case "list_provider_model_bindings":
      return Promise.resolve([
        IMAGE_BINDING,
        ALT_IMAGE_BINDING,
        TEXT_ONLY_IMAGE_BINDING,
        SECOND_PROVIDER_IMAGE_BINDING,
        SECOND_PROVIDER_ALT_IMAGE_BINDING,
        VIDEO_BINDING,
        ALT_VIDEO_BINDING,
        FAST_VIDEO_BINDING,
        SECOND_PROVIDER_VIDEO_BINDING,
        SECOND_PROVIDER_ALT_VIDEO_BINDING,
        {
          providerConnectionId: "moyu-production",
          modelDefinitionId: TEXT_MODEL.id,
          tokenGroup: null,
          enabledOperations: ["text_generation"],
          remoteModelId: null,
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ]);
    case "list_generation_tasks":
      return Promise.resolve({ items: [], nextCursorCreatedBefore: null });
    case "list_assets":
      return Promise.resolve(CLOUD_ASSETS);
    case "list_asset_groups":
      return Promise.resolve(mockAssetGroups);
    case "create_asset_group": {
      const created = {
        id: "22",
        name: "新分组",
        groupName: "新分组",
        isDefault: false,
        assetCount: 0,
      };
      mockAssetGroups = [...mockAssetGroups, created];
      return Promise.resolve(created);
    }
    case "delete_asset_group": {
      const groupId = (args?.["command"] as { id: string }).id;
      mockAssetGroups = mockAssetGroups.filter((group) => group.id !== groupId);
      return Promise.resolve(groupId);
    }
    case "rename_asset":
      return Promise.resolve("asset-image-1");
    case "start_generation":
      return Promise.resolve("task-1");
    case "prepare_video_edit_source":
      return Promise.resolve({ previewId: "preview-id", path: "C:/preview.mp4" });
    case "release_video_edit_source":
      return Promise.resolve(undefined);
    case "plugin:event|listen":
      return Promise.resolve(1);
    case "plugin:event|unlisten":
      return Promise.resolve(null);
    default:
      // plugin:log|* 等辅助命令统一静默成功。
      return Promise.resolve(null);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  tauriCallbacks.clear();
  nextTauriCallbackId = 1;
  mockAssetGroups = [
    { id: "0", name: "默认分组", groupName: "默认分组", isDefault: true, assetCount: 0 },
    { id: "21", name: "客户案例", groupName: "客户案例", isDefault: false, assetCount: 3 },
  ];
  mediaPlayMock.mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => mediaPlayMock());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => mediaPauseMock());
  invokeMock.mockImplementation((command, args) => baseInvokeImplementation(command, args));
  dialogOpenMock.mockResolvedValue(null);
  dialogSaveMock.mockResolvedValue(null);
  fileStatMock.mockResolvedValue({ isFile: true, size: 1024 });
  writeTextFileMock.mockResolvedValue(undefined);
  videoLocalEditInstructionMock.document = {
    schema: "prompt-content",
    version: 1,
    items: [{ kind: "text", text: "删除标记区域中的路人" }],
  };
  setupDesktopRuntime();
});

afterEach(async () => {
  // 不删除 __TAURI_INTERNALS__ / __TAURI_EVENT_PLUGIN_INTERNALS__：
  // RTL 卸载组件时 @tauri-apps/api 的事件反注册是异步微任务（晚于本钩子执行），
  // 删除会产生未处理拒绝。vitest 默认按文件隔离 jsdom 环境，不会泄漏到其他测试；
  // beforeEach 会重建 internals 并以 clearAllMocks 重置调用记录。
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("画布素材拖拽与连线（桌面运行时）", () => {
  it("初始画布为空，展示生成与视频合成模板", async () => {
    render(<App />);

    expect(await screen.findByText("画布为空")).toBeInTheDocument();
    expect(document.querySelectorAll(".canvas-gen-node")).toHaveLength(0);
    expect(document.querySelectorAll(".canvas-asset-node")).toHaveLength(0);
    expect(document.querySelectorAll(".edge--asset")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "拖拽创建图片生成节点" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拖拽创建视频生成节点" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拖拽创建视频拼接与合成节点" })).toBeInTheDocument();
  });

  it("拖线落点偏离目标端口时仍会自动吸附并完成连接", async () => {
    render(<App />);
    const asset = await addAssetNode("图片", "站台参考图", 220, 180);
    const generation = await addGenerationNode("图片", 920, 180);

    // 默认 20px 半径无法覆盖这个落点；画布扩大后的命中半径应允许自然的手部误差。
    connectViaHandles(asset, generation, { x: 36, y: 0 });

    await waitFor(() =>
      expect(document.querySelectorAll(".edge--asset-generation")).toHaveLength(1),
    );
    expect(screen.queryByRole("menu", { name: "常用生成节点" })).not.toBeInTheDocument();
  });

  it.each([
    ["图片生成", "image", "图片生成节点", 580, 480],
    ["视频生成", "video", "视频生成节点", 580, 900],
    ["提示词生成与优化", "prompt", "提示词生成节点", 520, 650],
  ] as const)(
    "拖线到空白后选择%s，在落点创建节点并自动连接素材",
    async (menuName, kind, nodeName, width, height) => {
      render(<App />);
      const asset = await addAssetNode("图片", "站台参考图", 180, 180);
      const pane = document.querySelector<HTMLElement>(".react-flow__pane")!;
      const dropPoint = { x: 980, y: 600 };

      dropConnectionFromHandle(asset, "source", pane, dropPoint);

      const menu = await screen.findByRole("menu", { name: "常用生成节点" });
      expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
      for (const name of ["图片生成", "视频生成", "提示词生成与优化"]) {
        expect(within(menu).getByRole("menuitem", { name })).toBeEnabled();
      }
      // 松开只显示选择菜单；确认类型后才创建节点及连线。
      expect(document.querySelectorAll(".canvas-gen-node")).toHaveLength(0);
      expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
      fireEvent.click(within(menu).getByRole("menuitem", { name: menuName }));

      const created = await waitFor(() => {
        const node = document.querySelector<HTMLElement>(`.canvas-gen-node--${kind}`);
        expect(node).not.toBeNull();
        return node!;
      });
      await waitForNodeAccessible(created);
      // 与节点仓库拖入一致：无碰撞时，新节点中心对齐画布落点。
      expect(rfNodeFlowPosition(created)).toEqual({
        x: dropPoint.x - width / 2,
        y: dropPoint.y - height / 2,
      });
      expect(
        await screen.findByRole("button", {
          name: `选择连线：站台参考图 → ${nodeName}；按 Delete 删除`,
        }),
      ).toBeInTheDocument();
      expect(
        within(created).getAllByRole("button", { name: "解除连线：站台参考图" }).length,
      ).toBeGreaterThan(0);
      expect(document.querySelectorAll(".canvas-gen-node")).toHaveLength(1);
      expect(screen.queryByRole("menu", { name: "常用生成节点" })).not.toBeInTheDocument();
    },
  );

  it("从输入端口反向拖线到空白可创建上游提示词，创建与连接可一次撤销重做", async () => {
    render(<App />);
    const generation = await addGenerationNode("图片", 980, 180);
    const pane = document.querySelector<HTMLElement>(".react-flow__pane")!;

    dropConnectionFromHandle(generation, "target", pane, { x: 180, y: 600 });
    const menu = await screen.findByRole("menu", { name: "常用生成节点" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "提示词生成与优化" }));

    const edgeName = "选择连线：提示词节点 → 图片生成节点；按 Delete 删除";
    expect(await screen.findByRole("button", { name: edgeName })).toBeInTheDocument();
    expect(document.querySelectorAll(".canvas-gen-node--prompt")).toHaveLength(1);
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "撤销画布操作" }));
    await waitFor(() => {
      expect(document.querySelectorAll(".canvas-gen-node--prompt")).toHaveLength(0);
      expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    });
    expect(document.querySelectorAll(".canvas-gen-node--image")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "重做画布操作" }));
    expect(await screen.findByRole("button", { name: edgeName })).toBeInTheDocument();
    expect(document.querySelectorAll(".canvas-gen-node--prompt")).toHaveLength(1);
    expect(document.querySelectorAll(".canvas-gen-node--image")).toHaveLength(1);
  });

  it.each(["Escape", "点击画布空白"])("拖线菜单通过%s取消后不创建节点或连线", async (cancelBy) => {
    render(<App />);
    const asset = await addAssetNode("图片", "站台参考图", 180, 180);
    const pane = document.querySelector<HTMLElement>(".react-flow__pane")!;
    dropConnectionFromHandle(asset, "source", pane, { x: 980, y: 600 });
    const menu = await screen.findByRole("menu", { name: "常用生成节点" });

    if (cancelBy === "Escape") {
      fireEvent.keyDown(menu, { key: "Escape" });
    } else {
      fireEvent.pointerDown(pane, { pointerId: 1, button: 0, clientX: 1200, clientY: 760 });
      fireEvent.click(pane, { clientX: 1200, clientY: 760 });
    }

    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "常用生成节点" })).not.toBeInTheDocument(),
    );
    expect(document.querySelectorAll(".canvas-gen-node")).toHaveLength(0);
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
    expect(document.body).toContainElement(asset);
  });

  it("拖线落在已有节点本体时不弹出常用生成节点菜单", async () => {
    render(<App />);
    const asset = await addAssetNode("图片", "站台参考图", 180, 180);
    const generation = await addGenerationNode("图片", 980, 180);
    const targetPosition = rfNodeFlowPosition(generation);

    dropConnectionFromHandle(asset, "source", generation, {
      x: targetPosition.x + 220,
      y: targetPosition.y + 140,
    });

    expect(screen.queryByRole("menu", { name: "常用生成节点" })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".canvas-gen-node")).toHaveLength(1);
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
  });

  it.each([
    ["知识教学视频", "添加工作流节点"],
    ["AI影视", "添加AI影视工作流节点"],
    ["漫剧自动", "添加漫剧自动工作流节点"],
    ["剧情带货", "添加剧情带货工作流节点"],
    ["动画逻辑图", "添加动画逻辑图工作流节点"],
    ["小红书封面", "添加小红书封面工作流节点"],
    ["短视频反推", "添加短视频反推工作流节点"],
  ])("%s工作流节点可通过左侧端口接收素材连线", async (_title, buttonName) => {
    render(<App />);
    const asset = await addAssetNode("图片", "站台参考图", 220, 180);
    const workflow = await addWorkflowNode(buttonName);

    expect(rfWrapperOf(workflow).querySelector(".react-flow__handle.target")).not.toBeNull();
    connectViaHandles(asset, workflow);

    const references = within(workflow).getByRole("region", { name: "工作流参考素材" });
    const connections = await within(references).findByRole("list", {
      name: "工作流连线参考素材",
    });
    expect(within(connections).getAllByRole("listitem")).toHaveLength(1);
    expect(connections).toHaveTextContent("站台参考图");
    expect(connections).toHaveTextContent("已连接 · 图片");
    expect(document.querySelectorAll(".edge--asset-generation")).toHaveLength(1);
  });

  it("拖线时高亮所有可连接目标的输入端口，结束拖线后高亮消失", async () => {
    render(<App />);
    // 视频素材可以连接图片生成和提示词节点，源节点自身不能自连。
    const videoAsset = await addAssetNode("视频", "列车进站参考", 148, 148);
    const imageGeneration = await addGenerationNode("图片", 700, 148);
    const promptNode = await addPromptNode(700, 500);

    const sourceHandle = rfWrapperOf(videoAsset).querySelector<HTMLElement>(
      ".react-flow__handle.source",
    );
    expect(sourceHandle).not.toBeNull();
    const from = rfNodeFlowPosition(videoAsset);

    // 开始拖线：mousedown 源端口 + 一次 mousemove 进入连接状态。
    fireCanvasMouse(sourceHandle!, "mousedown", clientFromFlow(from.x, from.y));
    fireCanvasMouse(document, "mousemove", clientFromFlow(from.x + 10, from.y + 10));

    const imageTarget = rfWrapperOf(imageGeneration).querySelector<HTMLElement>(
      ".react-flow__handle.target",
    );
    const promptTarget = rfWrapperOf(promptNode).querySelector<HTMLElement>(
      ".react-flow__handle.target",
    );
    expect(imageTarget).not.toBeNull();
    expect(promptTarget).not.toBeNull();

    // 所有不同节点的目标端口均高亮，源节点自己的输入端口不高亮。
    await waitFor(() => expect(imageTarget).toHaveClass("canvas-flow-handle--highlight"));
    expect(promptTarget).toHaveClass("canvas-flow-handle--highlight");
    expect(rfWrapperOf(videoAsset).querySelector(".react-flow__handle.target")).not.toHaveClass(
      "canvas-flow-handle--highlight",
    );

    // 结束拖线：mouseup 后高亮消失。
    fireCanvasMouse(document, "mouseup", clientFromFlow(from.x + 10, from.y + 10));
    await waitFor(() => expect(imageTarget).not.toHaveClass("canvas-flow-handle--highlight"));
    expect(promptTarget).not.toHaveClass("canvas-flow-handle--highlight");
  });

  it("工作流同时接收图片视频音频连线，断开单条连线后保留其他参考与节点", async () => {
    const audioAsset: CloudAsset = {
      providerConnectionId: PROVIDER.id,
      id: "asset-audio-1",
      kind: "audio",
      name: "旁白参考音频",
      status: "ready",
      rawStatus: "Active",
      previewUrl: "https://cdn.example.com/narration.mp3",
      assetUrl: "https://cdn.example.com/narration.mp3",
      coverUrl: null,
      groupId: null,
    };
    invokeMock.mockImplementation((command) =>
      command === "list_assets"
        ? Promise.resolve([...CLOUD_ASSETS, audioAsset])
        : baseInvokeImplementation(command),
    );
    render(<App />);
    const image = await addAssetNode("图片", "站台参考图", 220, 180);
    const video = await addAssetNode("视频", "列车进站参考", 220, 640);
    const audio = await addAssetNode("音频", "旁白参考音频", 720, 640);
    const workflow = await addWorkflowNode();

    for (const asset of [image, video, audio]) connectViaHandles(asset, workflow);
    const references = within(workflow).getByRole("region", { name: "工作流参考素材" });
    const connections = await within(references).findByRole("list", {
      name: "工作流连线参考素材",
    });
    expect(within(connections).getAllByRole("listitem")).toHaveLength(3);
    expect(connections).toHaveTextContent("站台参考图已连接 · 图片");
    expect(connections).toHaveTextContent("列车进站参考已连接 · 视频");
    expect(connections).toHaveTextContent("旁白参考音频已连接 · 音频");
    expect(references).toHaveTextContent("全部参考资料 3 项");
    expect(document.querySelectorAll(".edge--asset-generation")).toHaveLength(3);

    connectViaHandles(image, workflow);
    expect(within(connections).getAllByRole("listitem")).toHaveLength(3);
    expect(document.querySelectorAll(".edge--asset-generation")).toHaveLength(3);

    fireEvent.click(
      within(connections).getByRole("button", { name: "断开工作流素材：列车进站参考" }),
    );
    expect(within(connections).getAllByRole("listitem")).toHaveLength(2);
    expect(connections).not.toHaveTextContent("列车进站参考");
    expect(connections).toHaveTextContent("站台参考图");
    expect(connections).toHaveTextContent("旁白参考音频");
    expect(references).toHaveTextContent("全部参考资料 2 项");
    expect(document.querySelectorAll(".edge--asset-generation")).toHaveLength(2);
    expect(
      document.querySelectorAll(".canvas-asset-node:not(.canvas-asset-node--output)"),
    ).toHaveLength(3);
    expect(workflow).toBeInTheDocument();
    expect(video).toBeInTheDocument();
  });

  it("视频拼接与合成节点接收多段素材，并可用按钮调整合成顺序", async () => {
    render(<App />);
    const first = await addAssetNode("视频", "列车进站参考", 220, 180);
    const second = await addAssetNode("视频", "衣摆运动参考", 220, 640);
    const composer = await addVideoComposerNode(980, 360);

    connectAssetToGeneration(first, composer);
    connectAssetToGeneration(second, composer);

    const order = within(composer).getByRole("list", { name: "视频合成顺序" });
    expect(within(order).getAllByRole("listitem")[0]).toHaveTextContent("列车进站参考");
    expect(within(order).getAllByRole("listitem")[1]).toHaveTextContent("衣摆运动参考");
    expect(within(composer).getByRole("button", { name: "开始视频拼接与合成" })).toBeDisabled();

    fireEvent.click(within(composer).getByRole("button", { name: "上移第 2 段：衣摆运动参考" }));
    expect(within(order).getAllByRole("listitem")[0]).toHaveTextContent("衣摆运动参考");
    expect(within(order).getAllByRole("listitem")[1]).toHaveTextContent("列车进站参考");
  });

  it("网络爆款视频下载节点提取分享口令链接并下载为产物卡片", async () => {
    const startArgs: Array<Record<string, unknown> | undefined> = [];
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "start_video_download") {
        startArgs.push(args);
        return Promise.resolve({
          jobId: "download-test-1",
          url: "https://v.douyin.com/iAbCdEf/",
          status: "downloading",
          progress: 12,
          finalPath: null,
          fileName: null,
          qualityMode: null,
          qualityHint: null,
          watermarkRemoved: false,
          error: null,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      if (command === "get_video_download_job") {
        return Promise.resolve({
          jobId: "download-test-1",
          url: "https://v.douyin.com/iAbCdEf/",
          status: "completed",
          progress: 100,
          finalPath: "C:\\下载\\无限画布\\搞笑名场面 [73659182].mp4",
          fileName: "搞笑名场面 [73659182].mp4",
          qualityMode: null,
          qualityHint: null,
          watermarkRemoved: false,
          error: null,
          createdAt: 1,
          updatedAt: 2,
        });
      }
      if (command === "get_video_downloader_engine") {
        return Promise.resolve({
          state: "ready",
          version: "2026.08.19",
          binaryPath: "C:/engine/yt-dlp.exe",
          cookiesInstalled: false,
          bilibiliLoggedIn: false,
          lastError: null,
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const node = await addVideoDownloaderNode(920, 160);
    expect(within(node).getAllByText("yt-dlp 2026.08.19 · 就绪").length).toBeGreaterThanOrEqual(1);

    fireEvent.change(within(node).getByRole("textbox", { name: "视频链接" }), {
      target: {
        value: "8.15 Kfx:/ 复制打开抖音看看【作者】的作品 https://v.douyin.com/iAbCdEf/ 太搞笑了",
      },
    });
    await waitFor(() =>
      expect(within(node).getByRole("button", { name: "开始下载视频" })).toBeEnabled(),
    );
    fireEvent.click(within(node).getByRole("button", { name: "开始下载视频" }));

    await waitFor(() => {
      const startCall = startArgs.at(-1);
      expect(startCall).toBeDefined();
      // 前端原样提交输入；分享口令 → 纯链接的提取由后端负责（Rust 单测覆盖）。
      expect((startCall!["command"] as { url: string }).url).toBe(
        "8.15 Kfx:/ 复制打开抖音看看【作者】的作品 https://v.douyin.com/iAbCdEf/ 太搞笑了",
      );
    });

    // 首次轮询（700ms）返回 completed 后，产物卡片自动落到节点右侧并连线。
    await waitFor(
      () => expect(document.querySelectorAll(".canvas-asset-node--output")).toHaveLength(1),
      { timeout: 4000 },
    );
    await waitFor(() =>
      expect(within(node).getByText("下载完成 · 产物已落在右侧")).toBeInTheDocument(),
    );
    expect(document.querySelectorAll(".edge--asset")).toHaveLength(1);
  });

  it("视频抽帧节点连入视频素材后按秒数抽帧并逐帧落卡", async () => {
    const startArgs: Array<Record<string, unknown> | undefined> = [];
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "start_video_frame_extraction") {
        startArgs.push(args);
        return Promise.resolve({
          jobId: "frame-extract-test-1",
          videoPath: "https://example.com/列车进站参考.mp4",
          status: "processing",
          progress: 0,
          frames: [],
          error: null,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      if (command === "get_video_frame_extraction_job") {
        return Promise.resolve({
          jobId: "frame-extract-test-1",
          videoPath: "https://example.com/列车进站参考.mp4",
          status: "completed",
          progress: 100,
          frames: [
            {
              path: "C:\\下载\\无限画布\\抽帧\\列车进站参考@3.jpg",
              timestampSeconds: 3,
              width: 1080,
              height: 1920,
            },
            {
              path: "C:\\下载\\无限画布\\抽帧\\列车进站参考@8.5.jpg",
              timestampSeconds: 8.5,
              width: 1080,
              height: 1920,
            },
          ],
          error: null,
          createdAt: 1,
          updatedAt: 2,
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const videoAsset = await addAssetNode("视频", "列车进站参考", 220, 240);
    const extractor = await addFrameExtractorNode(980, 260);
    connectAssetToGeneration(videoAsset, extractor);

    fireEvent.change(within(extractor).getByLabelText("抽帧秒数，多个秒数用逗号分隔"), {
      target: { value: "3, 8.5" },
    });
    await waitFor(() =>
      expect(within(extractor).getByRole("button", { name: "开始视频抽帧" })).toBeEnabled(),
    );
    fireEvent.click(within(extractor).getByRole("button", { name: "开始视频抽帧" }));

    await waitFor(() => {
      const startCall = startArgs.at(-1);
      expect(startCall).toBeDefined();
      const command = startCall!["command"] as { videoPath: string; timestamps: number[] };
      // 云端视频素材的 videoUrl（签名 URL）原样交给后端，后端先下载到本地再抽帧。
      expect(command.videoPath).toBe("https://cdn.example.com/train.mp4");
      expect(command.timestamps).toEqual([3, 8.5]);
    });

    // 轮询返回 completed 后，逐帧生成 origin=frame_extract 的图片产物卡片并展示在节点内。
    await waitFor(
      () => expect(document.querySelectorAll(".canvas-asset-node--output")).toHaveLength(2),
      { timeout: 4000 },
    );
    await waitFor(() =>
      expect(within(extractor).getByText("抽帧完成 · 2 张图片已落在右侧")).toBeInTheDocument(),
    );
    expect(within(extractor).getAllByText(/@\d+(\.\d+)?\.jpg/).length).toBeGreaterThanOrEqual(1);
  });

  it("视频抽帧读取经中间节点传来的全部视频并逐个提交", async () => {
    const sources: string[] = [];
    invokeMock.mockImplementation((command, args) => {
      if (command === "start_video_frame_extraction") {
        const input = args?.["command"] as { videoPath: string; timestamps: number[] };
        sources.push(input.videoPath);
        expect(input.timestamps).toEqual([2]);
        return Promise.resolve({
          jobId: `batch-frame-${sources.length}`,
          videoPath: input.videoPath,
          status: "processing",
          progress: 0,
          frames: [],
          error: null,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      if (command === "get_video_frame_extraction_job") {
        const jobId = args?.["jobId"] as string;
        return Promise.resolve({
          jobId,
          videoPath: "C:/source.mp4",
          status: "completed",
          progress: 100,
          frames: [
            { path: `C:/frames/${jobId}.jpg`, timestampSeconds: 2, width: 100, height: 100 },
          ],
          error: null,
          createdAt: 1,
          updatedAt: 2,
        });
      }
      return baseInvokeImplementation(command);
    });
    render(<App />);
    const first = await addAssetNode("视频", "列车进站参考", 180, 180);
    const second = await addAssetNode("视频", "衣摆运动参考", 180, 640);
    const relay = await addPromptNode(650, 180);
    const extractor = await addFrameExtractorNode(1180, 300);
    connectViaHandles(first, relay);
    connectViaHandles(relay, extractor);
    connectViaHandles(second, extractor);
    const inputs = within(extractor).getByRole("list", { name: "视频抽帧输入" });
    expect(within(inputs).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.change(within(extractor).getByLabelText("抽帧秒数，多个秒数用逗号分隔"), {
      target: { value: "2" },
    });
    fireEvent.click(within(extractor).getByRole("button", { name: "开始视频抽帧" }));
    await waitFor(
      () =>
        expect(sources).toEqual([
          "https://cdn.example.com/train.mp4",
          "https://cdn.example.com/hem.mp4",
        ]),
      { timeout: 4000 },
    );
    await waitFor(
      () => expect(document.querySelectorAll(".canvas-asset-node--output")).toHaveLength(2),
      { timeout: 4000 },
    );
    expect(within(extractor).getByText("抽帧完成 · 2 张图片已落在右侧")).toBeInTheDocument();
  });

  it("下载节点从上游文本读取所有链接并按序下载", async () => {
    const urls: string[] = [];
    invokeMock.mockImplementation((command, args) => {
      if (command === "start_video_download") {
        urls.push((args?.["command"] as { url: string }).url);
        return Promise.resolve({
          jobId: `batch-download-${urls.length}`,
          url: urls.at(-1),
          status: "downloading",
          progress: 0,
          finalPath: null,
          fileName: null,
          qualityMode: null,
          qualityHint: null,
          watermarkRemoved: false,
          error: null,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      if (command === "get_video_download_job") {
        const jobId = args?.["jobId"] as string;
        return Promise.resolve({
          jobId,
          url: "https://example.com/video",
          status: "completed",
          progress: 100,
          finalPath: `C:/downloads/${jobId}.mp4`,
          fileName: `${jobId}.mp4`,
          qualityMode: null,
          qualityHint: null,
          watermarkRemoved: false,
          error: null,
          createdAt: 1,
          updatedAt: 2,
        });
      }
      return baseInvokeImplementation(command);
    });
    render(<App />);
    const prompt = await addPromptNode(240, 180);
    setPromptOutputText(
      prompt,
      "参考视频 https://example.com/one.mp4\n第二段 https://example.com/two.mp4",
    );
    const downloader = await addVideoDownloaderNode(1050, 200);
    connectViaHandles(prompt, downloader);
    expect(within(downloader).getByRole("textbox", { name: "视频链接" })).toHaveValue("");
    expect(within(downloader).getByLabelText("下载输入数量")).toHaveTextContent("2 个链接");
    fireEvent.click(within(downloader).getByRole("button", { name: "开始下载视频" }));
    await waitFor(
      () => expect(urls).toEqual(["https://example.com/one.mp4", "https://example.com/two.mp4"]),
      { timeout: 4000 },
    );
    await waitFor(
      () => expect(document.querySelectorAll(".canvas-asset-node--output")).toHaveLength(2),
      { timeout: 4000 },
    );
  });

  it("下载提交尚未返回时卸载画布，会取消迟到任务并停止后续链接", async () => {
    let resolveStart!: (value: unknown) => void;
    invokeMock.mockImplementation((command) =>
      command === "start_video_download"
        ? new Promise((resolve) => {
            resolveStart = resolve;
          })
        : baseInvokeImplementation(command),
    );
    const { unmount } = render(<App />);
    const downloader = await addVideoDownloaderNode(800, 200);
    fireEvent.change(within(downloader).getByRole("textbox", { name: "视频链接" }), {
      target: { value: "https://example.com/one.mp4 https://example.com/two.mp4" },
    });
    fireEvent.click(within(downloader).getByRole("button", { name: "开始下载视频" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_video_download", expect.anything()),
    );
    unmount();
    await act(async () => {
      resolveStart({
        jobId: "late-download",
        url: "https://example.com/one.mp4",
        status: "downloading",
        progress: 0,
        finalPath: null,
        fileName: null,
        qualityMode: null,
        qualityHint: null,
        watermarkRemoved: false,
        error: null,
        createdAt: 1,
        updatedAt: 1,
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("cancel_video_download", { jobId: "late-download" }),
    );
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "start_video_download"),
    ).toHaveLength(1);
  });

  it("复刻节点分别分析所有视频并汇总文档", async () => {
    const sample = vi.spyOn(videoFrameSampler, "buildVideoContactSheets").mockResolvedValue({
      duration: 5,
      width: 100,
      height: 100,
      overviewFrameCount: 2,
      tailFrameCount: 2,
      sheets: [
        {
          dataUrl: "data:image/jpeg;base64,dGVzdA==",
          displayName: "联系表",
          phase: "overview",
          firstTime: 0,
          lastTime: 4,
          frameCount: 2,
        },
      ],
    });
    invokeMock.mockImplementation((command, args) =>
      command === "run_prompt_node"
        ? Promise.resolve({
            optimizedPrompt: `分析完成：${(args?.["command"] as { userPrompt: string }).userPrompt.split("\n")[0]}`,
            rawModelOutput: "",
          })
        : baseInvokeImplementation(command),
    );
    render(<App />);
    const first = await addAssetNode("视频", "列车进站参考", 180, 180);
    const second = await addAssetNode("视频", "衣摆运动参考", 180, 640);
    const remix = await addViralRemixNode(1080, 180);
    connectViaHandles(first, remix);
    connectViaHandles(second, remix);
    await waitFor(() =>
      expect(within(remix).getByRole("button", { name: "开始复刻" })).toBeEnabled(),
    );
    fireEvent.click(within(remix).getByRole("button", { name: "开始复刻" }));
    await waitFor(() => expect(sample).toHaveBeenCalledTimes(2));
    expect(sample).toHaveBeenNthCalledWith(1, "https://cdn.example.com/train.mp4");
    expect(sample).toHaveBeenNthCalledWith(2, "https://cdn.example.com/hem.mp4");
    await waitFor(() =>
      expect(within(remix).getByLabelText("当前复刻方案预览")).toHaveTextContent(
        "分析完成：输入视频 2/2：衣摆运动参考",
      ),
    );
    expect(within(remix).getByLabelText("当前复刻方案预览")).toHaveTextContent(
      "分析完成：输入视频 1/2：列车进站参考",
    );
  });

  it("B 站链接展示画质路由提醒：未登录提示 480P，其他站点不提示", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_video_downloader_engine") {
        return Promise.resolve({
          state: "ready",
          version: "2026.08.19",
          binaryPath: "C:/engine/yt-dlp.exe",
          cookiesInstalled: true,
          bilibiliLoggedIn: false,
          lastError: null,
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const node = await addVideoDownloaderNode(920, 160);
    const input = within(node).getByRole("textbox", { name: "视频链接" });

    // 抖音链接：不出现 B 站画质路由提醒。
    fireEvent.change(input, { target: { value: "https://v.douyin.com/iAbCdEf/" } });
    expect(within(node).queryByText(/未登录 B 站/)).not.toBeInTheDocument();

    // B 站未登录：提示自动 480P。
    fireEvent.change(input, {
      target: { value: "https://www.bilibili.com/video/BV1YE6gBHEoN/" },
    });
    await waitFor(() => expect(within(node).getByText(/未登录 B 站.*480P/)).toBeInTheDocument());
    expect(
      within(node)
        .getByText(/未登录 B 站.*480P/)
        .closest(".canvas-video-downloader__quality"),
    ).not.toBeNull();
  });

  it("B 站已登录时画质路由提醒为最高画质", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_video_downloader_engine") {
        return Promise.resolve({
          state: "ready",
          version: "2026.08.19",
          binaryPath: "C:/engine/yt-dlp.exe",
          cookiesInstalled: true,
          bilibiliLoggedIn: true,
          lastError: null,
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const node = await addVideoDownloaderNode(920, 160);
    fireEvent.change(within(node).getByRole("textbox", { name: "视频链接" }), {
      target: { value: "https://b23.tv/AbCdEf" },
    });
    await waitFor(() =>
      expect(within(node).getByText(/已登录 B 站.*最高画质/)).toBeInTheDocument(),
    );
    expect(within(node).queryByText(/未登录 B 站/)).not.toBeInTheDocument();
  });

  it("B 站下载完成后展示已自动去除水印提示", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "start_video_download") {
        return Promise.resolve({
          jobId: "download-clean-1",
          url: "https://www.bilibili.com/video/BV1a2tb6rEwx/",
          status: "downloading",
          progress: 10,
          finalPath: null,
          fileName: null,
          qualityMode: "best",
          qualityHint: "已登录 B 站：将下载当前账号可用的最高画质。",
          watermarkRemoved: false,
          error: null,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      if (command === "get_video_download_job") {
        return Promise.resolve({
          jobId: "download-clean-1",
          url: "https://www.bilibili.com/video/BV1a2tb6rEwx/",
          status: "completed",
          progress: 100,
          finalPath: "C:\\下载\\无限画布\\标题 [BV1a2tb6rEwx]（去水印）.mp4",
          fileName: "标题 [BV1a2tb6rEwx]（去水印）.mp4",
          qualityMode: "best",
          qualityHint: "已登录 B 站：将下载当前账号可用的最高画质。",
          watermarkRemoved: true,
          error: null,
          createdAt: 1,
          updatedAt: 2,
        });
      }
      if (command === "get_video_downloader_engine") {
        return Promise.resolve({
          state: "ready",
          version: "2026.08.19",
          binaryPath: "C:/engine/yt-dlp.exe",
          cookiesInstalled: true,
          bilibiliLoggedIn: true,
          lastError: null,
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const node = await addVideoDownloaderNode(920, 160);
    fireEvent.change(within(node).getByRole("textbox", { name: "视频链接" }), {
      target: { value: "https://www.bilibili.com/video/BV1a2tb6rEwx/" },
    });
    fireEvent.click(within(node).getByRole("button", { name: "开始下载视频" }));

    await waitFor(
      () => expect(within(node).getByText(/已自动去除 B 站右上角水印/)).toBeInTheDocument(),
      { timeout: 4000 },
    );
  });

  it("爆款视频复刻节点可直连下载节点，并在下载完成后自动就绪", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "start_video_download") {
        return Promise.resolve({
          jobId: "download-remix-1",
          url: "https://v.douyin.com/remix/",
          status: "downloading",
          progress: 20,
          finalPath: null,
          fileName: null,
          qualityMode: null,
          qualityHint: null,
          watermarkRemoved: false,
          error: null,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      if (command === "get_video_download_job") {
        return Promise.resolve({
          jobId: "download-remix-1",
          url: "https://v.douyin.com/remix/",
          status: "completed",
          progress: 100,
          finalPath: "C:\\下载\\无限画布\\爆款样片.mp4",
          fileName: "爆款样片.mp4",
          qualityMode: null,
          qualityHint: null,
          watermarkRemoved: false,
          error: null,
          createdAt: 1,
          updatedAt: 2,
        });
      }
      if (command === "get_video_downloader_engine") {
        return Promise.resolve({
          state: "ready",
          version: "2026.08.19",
          binaryPath: "C:/engine/yt-dlp.exe",
          cookiesInstalled: false,
          bilibiliLoggedIn: false,
          lastError: null,
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const downloader = await addVideoDownloaderNode(260, 160);
    const remix = await addViralRemixNode(1080, 180);
    await waitFor(() =>
      expect(within(remix).getByLabelText("复刻文本模型")).toHaveValue(TEXT_MODEL.id),
    );

    connectDownloaderToRemix(downloader, remix);
    expect(within(remix).getByText("下载节点已连接 · 等待下载完成")).toBeInTheDocument();
    expect(within(remix).getByRole("button", { name: "开始复刻" })).toBeDisabled();

    fireEvent.change(within(downloader).getByRole("textbox", { name: "视频链接" }), {
      target: { value: "https://v.douyin.com/remix/" },
    });
    fireEvent.click(within(downloader).getByRole("button", { name: "开始下载视频" }));

    await waitFor(
      () =>
        expect(within(remix).getByText("下载节点已就绪 · 运行时本地密集抽帧")).toBeInTheDocument(),
      { timeout: 4_000 },
    );
    expect(within(remix).getByRole("button", { name: "开始复刻" })).toBeEnabled();
    expect(document.querySelectorAll(".edge--asset")).toHaveLength(2);
  });

  it("提示词节点调用文本模型并把输出自动导入下游图片请求", async () => {
    const generatedPrompt = "电影感雨夜站台，女孩撑伞等候列车，镜头缓慢推进。";
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        return Promise.resolve({
          optimizedPrompt: generatedPrompt,
          rawModelOutput: generatedPrompt,
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: "雨夜站台，女孩撑伞等候列车" },
    });
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("run_prompt_node", expect.anything()),
    );
    const promptCommand = invokeMock.mock.calls.find(
      ([command]) => command === "run_prompt_node",
    )?.[1] as {
      command: Record<string, unknown>;
    };
    expect(promptCommand.command).toMatchObject({
      providerConnectionId: PROVIDER.id,
      modelDefinitionId: TEXT_MODEL.id,
      task: "generate",
      mode: "seedance_2_5",
      userPrompt: "雨夜站台，女孩撑伞等候列车",
    });
    await waitFor(() =>
      expect(getPromptOutputEditor(promptNode)).toHaveTextContent(generatedPrompt),
    );

    const promptOutput = getPromptOutputEditor(promptNode);
    expect(within(promptNode).queryByRole("button", { name: /审计/ })).not.toBeInTheDocument();
    const customPrompt = `${generatedPrompt} 自定义镜头节奏。`;
    setPromptText(promptOutput, customPrompt);
    expect(promptOutput).toHaveTextContent(customPrompt);

    const imageNode = await addGenerationNode("图片", 920, 180);
    connectPromptToGeneration(promptNode, imageNode);
    const generationPrompt = within(imageNode).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    await waitFor(() => expect(generationPrompt).toHaveTextContent(customPrompt));
    expect(document.querySelector(".edge--prompt-generation")).not.toBeNull();

    const videoNode = await addGenerationNode("视频", 920, 520);
    connectPromptToGeneration(promptNode, videoNode);
    await waitFor(() =>
      expect(
        within(videoNode).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      ).toHaveTextContent(customPrompt),
    );
    expect(document.querySelectorAll(".edge--prompt-generation")).toHaveLength(2);

    fireEvent.click(within(imageNode).getByRole("button", { name: "开始图片生成" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_generation", expect.anything()),
    );
    const generationCommand = submittedGenerationCommands().at(-1)!;
    expect(generationCommand["prompt"]).toEqual([{ kind: "text", text: customPrompt }]);
  });

  it("提示词生成期间切换独立画布，迟到结果只回到原画布", async () => {
    const generatedPrompt = "属于广告画布的雨夜站台镜头提示词。";
    let resolvePrompt!: (result: { optimizedPrompt: string; rawModelOutput: string }) => void;
    const pendingPrompt = new Promise<{ optimizedPrompt: string; rawModelOutput: string }>(
      (resolve) => {
        resolvePrompt = resolve;
      },
    );
    invokeMock.mockImplementation((command, args) => {
      if (command === "run_prompt_node") return pendingPrompt;
      return baseInvokeImplementation(command, args);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "新建画布" })).toBeEnabled());
    await waitFor(() => expect(screen.queryByText("正在读取画布…")).not.toBeInTheDocument());
    const originalTab = within(screen.getByRole("tablist", { name: "创作画布" })).getByRole("tab", {
      selected: true,
    });
    const originalCanvasId = originalTab.id.replace("canvas-tab-", "");
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: "广告场景：雨夜站台" },
    });
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("run_prompt_node", expect.anything()),
    );
    const request = invokeMock.mock.calls.find(([command]) => command === "run_prompt_node")?.[1]?.[
      "command"
    ];
    expect(request).toMatchObject({ canvasId: originalCanvasId, userPrompt: "广告场景：雨夜站台" });

    fireEvent.click(screen.getByRole("button", { name: "新建画布" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "画布 2" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(document.querySelectorAll(".canvas-gen-node")).toHaveLength(0);
    await act(async () => {
      resolvePrompt({ optimizedPrompt: generatedPrompt, rawModelOutput: generatedPrompt });
      await pendingPrompt;
    });
    expect(document.querySelectorAll(".canvas-gen-node--prompt")).toHaveLength(0);
    expect(document.querySelectorAll(".canvas-gen-node")).toHaveLength(0);
    expect(screen.getByText("画布为空")).toBeInTheDocument();

    await waitFor(() => expect(originalTab).toBeEnabled());
    fireEvent.click(originalTab);
    await waitFor(() => expect(originalTab).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => {
      const promptNode = document.querySelector(".canvas-gen-node--prompt") as HTMLElement;
      expect(promptNode).not.toBeNull();
      expect(getPromptOutputEditor(promptNode)).toHaveTextContent(generatedPrompt);
    });
    expect(document.querySelectorAll(".canvas-gen-node--prompt")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_prompt_node")).toHaveLength(
      1,
    );
  });

  it("删除画布时阻止尚未完成的提示词任务，取消删除后仍接收生成结果", async () => {
    const generatedPrompt = "删除被阻止后完整保留的雨夜站台镜头提示词。";
    let resolvePrompt!: (result: { optimizedPrompt: string; rawModelOutput: string }) => void;
    const pendingPrompt = new Promise<{ optimizedPrompt: string; rawModelOutput: string }>(
      (resolve) => {
        resolvePrompt = resolve;
      },
    );
    invokeMock.mockImplementation((command, args) => {
      if (command === "run_prompt_node") return pendingPrompt;
      return baseInvokeImplementation(command, args);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "新建画布" })).toBeEnabled());
    await waitFor(() => expect(screen.queryByText("正在读取画布…")).not.toBeInTheDocument());
    const originalTab = within(screen.getByRole("tablist", { name: "创作画布" })).getByRole("tab", {
      selected: true,
    });
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: "广告场景：雨夜站台" },
    });
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("run_prompt_node", expect.anything()),
    );

    fireEvent.click(screen.getByRole("button", { name: /^删除画布 / }));
    const dialog = await screen.findByRole("dialog", { name: "删除画布？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent("此画布仍有任务正在执行"),
    );
    expect(originalTab).toHaveAttribute("aria-selected", "true");
    expect(invokeMock).not.toHaveBeenCalledWith("delete_canvas_document", expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "删除画布？" })).not.toBeInTheDocument();

    await act(async () => {
      resolvePrompt({ optimizedPrompt: generatedPrompt, rawModelOutput: generatedPrompt });
      await pendingPrompt;
    });
    await waitFor(() =>
      expect(getPromptOutputEditor(promptNode)).toHaveTextContent(generatedPrompt),
    );
    expect(within(promptNode).getByRole("button", { name: "生成提示词" })).toBeEnabled();
    expect(originalTab).toHaveAttribute("aria-selected", "true");
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_prompt_node")).toHaveLength(
      1,
    );
  });

  it("删除画布时重新检查桌面生成任务，活动任务或检查失败均保留画布", async () => {
    let failTaskCheck = false;
    invokeMock.mockImplementation((command, args) => {
      const query = args?.["query"] as
        { canvasId?: string; statuses?: readonly string[] } | undefined;
      if (command === "list_generation_tasks" && query?.statuses) {
        if (failTaskCheck) return Promise.reject(new Error("无法检查生成任务状态"));
        if (!query.canvasId) throw new Error("删除前检查必须指定所属画布");
        return Promise.resolve({
          items: [makeTaskSummary({ canvasId: query.canvasId, status: "running" })],
          nextCursorCreatedBefore: null,
        });
      }
      return baseInvokeImplementation(command, args);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "新建画布" })).toBeEnabled());
    await waitFor(() => expect(screen.queryByText("正在读取画布…")).not.toBeInTheDocument());
    const originalTab = within(screen.getByRole("tablist", { name: "创作画布" })).getByRole("tab", {
      selected: true,
    });
    const canvasId = originalTab.id.replace("canvas-tab-", "");
    fireEvent.click(screen.getByRole("button", { name: /^删除画布 / }));
    const dialog = await screen.findByRole("dialog", { name: "删除画布？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent("此画布仍有生成任务正在执行"),
    );
    expect(invokeMock).toHaveBeenCalledWith("list_generation_tasks", {
      query: {
        canvasId,
        statuses: ["created", "submitting", "retry_wait", "queued", "running"],
        limit: 1,
      },
    });
    expect(invokeMock).not.toHaveBeenCalledWith("delete_canvas_document", expect.anything());

    failTaskCheck = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent("无法检查生成任务状态"),
    );
    expect(originalTab).toHaveAttribute("aria-selected", "true");
    expect(invokeMock).not.toHaveBeenCalledWith("delete_canvas_document", expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  });

  it("上游输出未变时保留手改和断线引用，保存恢复不按新编号重绑", async () => {
    let storedDocument: unknown = null;
    invokeMock.mockImplementation((command, args) => {
      if (command === "get_canvas_document") {
        if (storedDocument == null) {
          return Promise.reject(
            Object.assign(new Error("canvas not found"), { kind: "not_found" }),
          );
        }
        return Promise.resolve({
          id: "canvas-scene-03",
          title: "未命名画布",
          document: storedDocument,
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      if (command === "save_canvas_document") {
        const save = args?.["command"] as { id: string; title: string; document: unknown };
        storedDocument = structuredClone(save.document);
        return Promise.resolve({ ...save, revision: 1, createdAt: 0, updatedAt: 0 });
      }
      return baseInvokeImplementation(command);
    });
    const view = render(<App />);
    const promptNode = await addPromptNode(260, 180);
    setPromptOutputText(promptNode, "@图片1 开场");
    const videoNode = await addGenerationNode("视频", 920, 180);
    const firstAsset = await addAssetNode("图片", "站台参考图", 20, 500);
    const secondAsset = await addAssetNode("图片", "站台参考图", 20, 760);
    connectAssetToGeneration(firstAsset, videoNode);
    connectAssetToGeneration(secondAsset, videoNode);
    connectPromptToGeneration(promptNode, videoNode);
    const videoKey = videoNode.dataset["connectionTarget"]!;
    const firstKey = firstAsset.dataset["connectionTarget"]!;
    const secondKey = secondAsset.dataset["connectionTarget"]!;
    const input = within(videoNode).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    const originalChip = await waitFor(() => {
      const chip = input.querySelector<HTMLElement>("[data-mention-id]")!;
      expect(chip).toHaveAttribute("data-canvas-node-key", firstKey);
      return chip;
    });
    const mentionId = originalChip.dataset["mentionId"]!;
    appendPromptText(input, "，保留我的手改");
    fireEvent.click(within(videoNode).getAllByRole("button", { name: "解除连线：站台参考图" })[0]!);
    await waitFor(() => {
      expect(input.querySelector(`[data-mention-id="${mentionId}"]`)).toHaveClass("is-stale");
      expect(input).toHaveTextContent("保留我的手改");
    });
    expect(input.querySelector("[data-mention-id]")).toHaveAttribute(
      "data-canvas-node-key",
      firstKey,
    );

    view.unmount();
    await waitFor(() => expect(storedDocument).not.toBeNull());
    render(<App />);
    const restoredVideo = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(`[data-connection-target="${videoKey}"]`);
      expect(node).not.toBeNull();
      return node!;
    });
    await waitForNodeAccessible(restoredVideo);
    const restoredInput = within(restoredVideo).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    const restoredChip = await waitFor(() => {
      const chip = restoredInput.querySelector<HTMLElement>("[data-mention-id]");
      expect(chip).not.toBeNull();
      expect(chip).toHaveClass("is-stale");
      return chip!;
    });
    expect(restoredChip).toHaveAttribute("data-canvas-node-key", firstKey);
    expect(restoredChip).toHaveAttribute("data-mention-id", mentionId);
    expect(restoredInput).toHaveTextContent("开场");
    expect(restoredInput).toHaveTextContent("保留我的手改");

    const restoredPromptNode = document.querySelector(".canvas-gen-node--prompt") as HTMLElement;
    setPromptOutputText(restoredPromptNode, "@图片1 上游新版本");
    await waitFor(() => {
      expect(restoredInput).toHaveTextContent("上游新版本");
      expect(restoredInput).not.toHaveTextContent("保留我的手改");
      expect(restoredInput.querySelector("[data-mention-id]")).toHaveAttribute(
        "data-canvas-node-key",
        secondKey,
      );
    });
  });

  it("新连接的提示词源即使输出相同，也会重新同步下游内容", async () => {
    render(<App />);
    const firstSource = await addPromptNode(260, 180);
    setPromptOutputText(firstSource, "上游共同输出");
    const target = await addGenerationNode("视频", 920, 180);
    connectPromptToGeneration(firstSource, target);
    const input = within(target).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    await waitFor(() => expect(input).toHaveTextContent("上游共同输出"));
    setPromptText(input, "下游临时修改");
    const secondSource = await addPromptNode(260, 720);
    setPromptOutputText(secondSource, "上游共同输出");
    expect(input).toHaveTextContent("下游临时修改");
    connectPromptToGeneration(secondSource, target);
    await waitFor(() => expect(input).toHaveTextContent("上游共同输出"));
    expect(input).not.toHaveTextContent("下游临时修改");
  });

  it("FPV 路径支持仅图片生成、基于手改输出继续优化并下发到视频请求", async () => {
    const firstPrompt = "FPV 从雨夜站台低空起飞，绕过立柱后沿铁轨向前飞行。";
    const editedPrompt = `${firstPrompt} 离地 1.5 米，终点停在站台尽头的时钟前。`;
    const optimizedPrompt = `${editedPrompt} 在立柱前减速，保持朝向前方并连续出弯。`;
    const cleanImage: CloudAsset = {
      ...CLOUD_ASSETS[0]!,
      id: "asset-image-clean",
      name: "站台干净底图",
      previewUrl: "https://cdn.example.com/station-clean.jpg",
      assetUrl: "https://cdn.example.com/station-clean.jpg",
    };
    let promptRunCount = 0;
    invokeMock.mockImplementation((command) => {
      if (command === "list_assets") return Promise.resolve([...CLOUD_ASSETS, cleanImage]);
      if (command === "run_prompt_node") {
        const output = promptRunCount++ === 0 ? firstPrompt : optimizedPrompt;
        return Promise.resolve({ optimizedPrompt: output, rawModelOutput: output });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    fireEvent.change(within(promptNode).getByLabelText("提示词技能模式"), {
      target: { value: "fpv_path" },
    });
    expect(within(promptNode).getByLabelText("提示词技能模式")).toHaveDisplayValue("FPV 路径");

    const imageAsset = await addAssetNode("图片", "站台参考图", 20, 700);
    connectAssetToGeneration(imageAsset, promptNode);
    await waitFor(() =>
      expect(within(promptNode).getByRole("list", { name: "已连入的参考素材" })).toHaveTextContent(
        "站台参考图",
      ),
    );
    expect(within(promptNode).getByRole("textbox", { name: "创意或需求" })).toHaveValue("");
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));

    const output = getPromptOutputEditor(promptNode);
    await waitFor(() => expect(output).toHaveTextContent(firstPrompt));
    const firstCommand = invokeMock.mock.calls.find(
      ([command]) => command === "run_prompt_node",
    )?.[1] as { command: Record<string, unknown> };
    expect(firstCommand.command).toMatchObject({
      providerConnectionId: PROVIDER.id,
      modelDefinitionId: TEXT_MODEL.id,
      mode: "fpv_path",
      task: "generate",
      contextHistory: [],
      visionImages: [
        {
          displayName: "站台参考图",
          target: {
            kind: "asset",
            assetId: "asset-image-1",
            mediaType: "image",
            providerConnectionId: PROVIDER.id,
          },
        },
      ],
    });
    expect(firstCommand.command["userPrompt"]).toMatch(/\S/);

    setPromptText(output, editedPrompt);
    fireEvent.click(within(promptNode).getByRole("button", { name: "优化" }));
    expect(within(promptNode).getByRole("textbox", { name: "待优化提示词" })).toHaveValue("");
    fireEvent.click(within(promptNode).getByRole("button", { name: "优化提示词" }));
    await waitFor(() => expect(output).toHaveTextContent(optimizedPrompt));

    const secondCommand = invokeMock.mock.calls.filter(
      ([command]) => command === "run_prompt_node",
    )[1]?.[1] as { command: Record<string, unknown> };
    expect(secondCommand.command).toMatchObject({
      mode: "fpv_path",
      task: "optimize",
      visionImages: firstCommand.command["visionImages"],
    });
    expect(secondCommand.command["userPrompt"]).toMatch(/\S/);
    expect(secondCommand.command["contextHistory"]).toEqual(
      expect.arrayContaining([
        { role: "第 1 条 · 你", content: firstCommand.command["userPrompt"] },
        { role: "第 2 条 · 提示词助手", content: firstPrompt },
        { role: "当前输出提示词", content: editedPrompt },
      ]),
    );

    const videoNode = await addGenerationNode("视频", 920, 180);
    connectPromptToGeneration(promptNode, videoNode);
    await waitFor(() =>
      expect(
        within(videoNode).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      ).toHaveTextContent(optimizedPrompt),
    );
    fireEvent.click(within(videoNode).getByRole("button", { name: "开始视频生成" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_generation", expect.anything()),
    );
    expect(submittedGenerationCommands().at(-1)?.["prompt"]).toEqual([
      { kind: "text", text: optimizedPrompt },
    ]);
    const pathReference = {
      target: {
        kind: "asset",
        providerConnectionId: PROVIDER.id,
        assetId: "asset-image-1",
        canvasNodeKey: imageAsset.dataset["connectionTarget"],
        mediaType: "image",
      },
      role: "reference_image",
      displayNameSnapshot: "站台参考图",
      typePosition: 1,
      contentIndex: 1,
    };
    expect(submittedGenerationCommands().at(-1)?.["explicitMedia"]).toEqual([pathReference]);

    const cleanReference = await addAssetNode("图片", cleanImage.name, 20, 700);
    connectAssetToGeneration(cleanReference, videoNode);
    const videoReferences = within(videoNode).getByRole("list", {
      name: "生成参考素材，按传入顺序排列",
    });
    expect(videoReferences).toHaveTextContent(cleanImage.name);
    expect(videoReferences).toHaveTextContent("站台参考图");
    expect(within(videoReferences).getAllByRole("listitem")).toHaveLength(2);
    await waitFor(() =>
      expect(within(videoNode).getByRole("button", { name: "开始视频生成" })).toBeEnabled(),
    );
    fireEvent.click(within(videoNode).getByRole("button", { name: "开始视频生成" }));
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(2));
    expect(submittedGenerationCommands()[1]?.["explicitMedia"]).toEqual([
      pathReference,
      {
        target: {
          kind: "asset",
          providerConnectionId: PROVIDER.id,
          assetId: cleanImage.id,
          canvasNodeKey: cleanReference.dataset["connectionTarget"],
          mediaType: "image",
        },
        role: "reference_image",
        displayNameSnapshot: cleanImage.name,
        typePosition: 2,
        contentIndex: 2,
      },
    ]);

    // 下游干净底图的连接不改变提示词节点实际读取的路径图。
    fireEvent.click(within(promptNode).getByRole("button", { name: "优化提示词" }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "run_prompt_node"),
      ).toHaveLength(3),
    );
    const thirdCommand = invokeMock.mock.calls.filter(
      ([command]) => command === "run_prompt_node",
    )[2]?.[1] as { command: Record<string, unknown> };
    expect(thirdCommand.command["visionImages"]).toEqual(firstCommand.command["visionImages"]);
  });

  it.each([
    ["FPV 路径", "fpv_path", "从站台入口穿过两根立柱，在时钟前停下，飞行高度 1.5 米"],
    ["打斗导演", "fight_prompt_master", "SD2.5，15 秒，超高速，雨夜站台两人徒手近战"],
    ["多宫格分镜", "multi_grid_storyboard", "6 宫格，12 秒，电影写实，女孩在站台发现一封信"],
    ["故事板", "storyboard_prompt", "咖啡品牌广告，6 格故事板，清晨出发到温暖重逢，16:9，手绘风格"],
  ])("%s 无图时拦截空请求，并允许仅文字描述生成", async (_label, mode, userPrompt) => {
    const generatedPrompt = `根据要求完成的提示词方案：${userPrompt}`;
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        return Promise.resolve({
          optimizedPrompt: generatedPrompt,
          rawModelOutput: generatedPrompt,
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    fireEvent.change(within(promptNode).getByLabelText("提示词技能模式"), {
      target: { value: mode },
    });
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    expect(await within(promptNode).findByRole("alert")).toHaveTextContent(/\S/);
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_prompt_node")).toEqual([]);

    fireEvent.click(within(promptNode).getByRole("button", { name: "优化" }));
    fireEvent.click(within(promptNode).getByRole("button", { name: "优化提示词" }));
    expect(await within(promptNode).findByRole("alert")).toHaveTextContent(
      "请输入需要优化的提示词。",
    );
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_prompt_node")).toEqual([]);
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成" }));

    fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: userPrompt },
    });
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    await waitFor(() =>
      expect(getPromptOutputEditor(promptNode)).toHaveTextContent(generatedPrompt),
    );
    expect(within(promptNode).queryByRole("alert")).not.toBeInTheDocument();
    const promptCommands = invokeMock.mock.calls.filter(
      ([command]) => command === "run_prompt_node",
    );
    expect(promptCommands).toHaveLength(1);
    expect(promptCommands[0]?.[1]).toMatchObject({
      command: {
        mode,
        task: "generate",
        userPrompt,
        contextHistory: [],
        visionImages: [],
      },
    });
  });

  it.each([
    ["打斗导演", "fight_prompt_master"],
    ["多宫格分镜", "multi_grid_storyboard"],
    ["故事板", "storyboard_prompt"],
  ])("%s 保留素材补问、完整方案与手改输出，并下发给图片和视频节点", async (label, mode) => {
    const isMultiGrid = mode === "multi_grid_storyboard";
    const isStoryboard = mode === "storyboard_prompt";
    const clarification = isMultiGrid
      ? "请补充 4 / 6 / 9 宫格、目标时长和风格，并确认女孩发现信封的剧情建议。"
      : isStoryboard
        ? "这张站台参考图将用于品牌广告还是电影叙事？请确认故事的核心情绪。"
        : "请补充目标视频模型（SD2.0 / SD2.5 / H3）、时长和速度档。";
    const generatedPrompts = isMultiGrid
      ? "图片提示词\n2×3 六宫格，按阅读顺序展示女孩走入站台、发现信封、捡起、打开、阅读与抬头。\n\n视频提示词\n第一格缓慢推近，第二格以视线引导发现信封，逐格延续角色动作与场景光线。\n\n时长分配\n| 格 | 秒 |\n| --- | --- |\n| 1 | 2 |\n| 2 | 2 |\n| 3 | 2 |\n| 4 | 2 |\n| 5 | 2 |\n| 6 | 2 |\n总时长 12 秒。\n\n资产清单\n角色：红衣女孩；场景：雨夜站台；道具：信封。"
      : isStoryboard
        ? "生成一张 16:9 横向咖啡品牌故事板，2 行×3 列，共 6 格，按从左到右、从上到下阅读。全板采用温暖手绘风格、统一格间留白与角色设计。红衣女孩始终保留短发与左手纸杯。第一格：站台全景，清晨出发；第二格：中景等候；第三格：手握咖啡特写；第四格：目光转向抵站列车；第五格：与朋友相遇；第六格：双人共享温暖时刻与自然出现的咖啡杯。动作、服装、场景与光线跨格连续；无多余文字、水印或格外画面。"
        : "高强度\n角色贴身抢攻，防守方格挡后反击。\n\n中间型\n双方试探后交锋。\n\n慢节奏\n凝视、蓄势，再完成一组攻防。";
    const editedPrompt = `${generatedPrompts}\n手动补充：保留红衣角色的左手动作。`;
    const optimizedPrompt = `${editedPrompt}\n优化：镜头清晰交代动作因果并保持场景一致。`;
    const replies = [clarification, generatedPrompts, optimizedPrompt];
    let runCount = 0;
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        const reply = replies[runCount++]!;
        return Promise.resolve({ optimizedPrompt: reply, rawModelOutput: reply });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    fireEvent.change(within(promptNode).getByLabelText("提示词技能模式"), {
      target: { value: mode },
    });
    expect(within(promptNode).getByLabelText("提示词技能模式")).toHaveDisplayValue(label);
    expect(within(promptNode).getByLabelText("提示词技能模式")).toHaveAccessibleDescription(
      isMultiGrid
        ? /在对话中指定 4 \/ 6 \/ 9 宫格、目标时长和风格，已填写的参数会继续沿用/
        : isStoryboard
          ? /输出可直接交给图片节点的整张故事板提示词/
          : /在对话中指定目标视频模型（SD2.0 \/ SD2.5 \/ H3）/,
    );
    const referenceImage = await addAssetNode("图片", "站台参考图", 20, 700);
    connectAssetToGeneration(referenceImage, promptNode);
    expect(within(promptNode).getByRole("textbox", { name: "创意或需求" })).toHaveValue("");
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    const output = getPromptOutputEditor(promptNode);
    await waitFor(() => expect(output).toHaveTextContent(clarification));
    expect(within(promptNode).getByRole("log", { name: "提示词多轮对话" })).toHaveTextContent(
      clarification,
    );
    const firstCommand = invokeMock.mock.calls.filter(
      ([command]) => command === "run_prompt_node",
    )[0]?.[1] as {
      command: Record<string, unknown>;
    };
    expect(firstCommand.command).toMatchObject({
      mode,
      task: "generate",
      modelDefinitionId: TEXT_MODEL.id,
      contextHistory: [],
      visionImages: [
        { displayName: "站台参考图", target: { kind: "asset", assetId: "asset-image-1" } },
      ],
    });
    if (isStoryboard) {
      expect(firstCommand.command["userPrompt"]).toContain("实际可见的人物、场景与风格");
      expect(firstCommand.command["userPrompt"]).toContain("不把参考画面当作已确认的剧情");
    }
    const parameters = isMultiGrid
      ? "6 宫格，12 秒，电影写实，采用女孩发现信封的剧情"
      : isStoryboard
        ? "咖啡品牌广告，6 格，16:9，温暖手绘风格，女孩在站台与朋友重逢"
        : "SD2.5，15 秒，超高速，站台上的两人徒手近战";
    fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: parameters },
    });
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    await waitFor(() => expect(output).toHaveTextContent(noNewlines(generatedPrompts)));
    setPromptText(output, editedPrompt);
    fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: "" },
    });
    fireEvent.click(within(promptNode).getByRole("button", { name: "优化" }));
    fireEvent.click(within(promptNode).getByRole("button", { name: "优化提示词" }));
    await waitFor(() => expect(output).toHaveTextContent(noNewlines(optimizedPrompt)));
    const thirdCommand = invokeMock.mock.calls.filter(
      ([command]) => command === "run_prompt_node",
    )[2]?.[1] as {
      command: Record<string, unknown>;
    };
    expect(thirdCommand.command).toMatchObject({
      mode,
      task: "optimize",
      visionImages: firstCommand.command["visionImages"],
      contextHistory: [
        { role: "第 1 条 · 你", content: firstCommand.command["userPrompt"] },
        { role: "第 2 条 · 提示词助手", content: clarification },
        { role: "第 3 条 · 你", content: parameters },
        { role: "第 4 条 · 提示词助手", content: generatedPrompts },
        { role: "当前输出提示词", content: editedPrompt },
      ],
    });
    expect(thirdCommand.command["userPrompt"]).toMatch(/继续优化当前输出/);
    expect(submittedGenerationCommands()).toHaveLength(0);
    const videoNode = await addGenerationNode("视频", 920, 180);
    connectPromptToGeneration(promptNode, videoNode);
    await waitFor(() =>
      expect(
        within(videoNode).getByRole("list", { name: "生成参考素材，按传入顺序排列" }),
      ).toHaveTextContent("站台参考图"),
    );
    fireEvent.click(within(videoNode).getByRole("button", { name: "开始视频生成" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_generation", expect.anything()),
    );
    expect(submittedGenerationCommand()["prompt"]).toEqual([
      { kind: "text", text: optimizedPrompt },
    ]);
    expect(submittedGenerationCommand()["explicitMedia"]).toEqual([
      {
        target: {
          kind: "asset",
          providerConnectionId: PROVIDER.id,
          assetId: "asset-image-1",
          canvasNodeKey: referenceImage.dataset["connectionTarget"],
          mediaType: "image",
        },
        role: "reference_image",
        displayNameSnapshot: "站台参考图",
        typePosition: 1,
        contentIndex: 1,
      },
    ]);

    const imageNode = await addGenerationNode("图片", 720, 520);
    connectPromptToGeneration(promptNode, imageNode);
    await waitFor(() =>
      expect(
        within(imageNode).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      ).toHaveTextContent("优化：镜头清晰交代动作因果并保持场景一致。"),
    );
    fireEvent.click(within(imageNode).getByRole("button", { name: "开始图片生成" }));
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(2));
    expect(submittedGenerationCommands().at(-1)?.["prompt"]).toEqual([
      { kind: "text", text: optimizedPrompt },
    ]);
  });

  it("多轮生成与优化会携带之前的完整对话上下文", async () => {
    const firstPrompt = "电影感雨夜站台，女孩撑伞等候列车。";
    const secondPrompt = `${firstPrompt} 加入车灯在水面的暖色反射。`;
    const thirdPrompt = `${secondPrompt} 镜头缓慢推近。`;
    const replies = [firstPrompt, secondPrompt, thirdPrompt];
    let promptRunCount = 0;
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        const optimizedPrompt = replies[Math.min(promptRunCount, replies.length - 1)];
        promptRunCount += 1;
        return Promise.resolve({ optimizedPrompt, rawModelOutput: optimizedPrompt });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    const composer = within(promptNode).getByRole("textbox", { name: "创意或需求" });
    const promptOutput = getPromptOutputEditor(promptNode);

    // 第 1 轮：生成。首轮无历史，contextHistory 为空数组。
    fireEvent.change(composer, { target: { value: "雨夜站台，女孩撑伞等候列车" } });
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    await waitFor(() => expect(promptOutput).toHaveTextContent(firstPrompt));
    const firstCommand = invokeMock.mock.calls.find(
      ([command]) => command === "run_prompt_node",
    )?.[1] as { command: Record<string, unknown> };
    expect(firstCommand.command).toMatchObject({
      task: "generate",
      userPrompt: "雨夜站台，女孩撑伞等候列车",
      contextHistory: [],
    });

    // 第 1 轮消息落入对话记录。
    const conversationLog = within(promptNode).getByRole("log", { name: "提示词多轮对话" });
    expect(within(conversationLog).getByText("雨夜站台，女孩撑伞等候列车")).toBeInTheDocument();
    expect(within(conversationLog).getByText("提示词助手")).toBeInTheDocument();

    // 第 2 轮：切换为优化，请求必须携带第 1 轮的用户消息与助手输出。
    fireEvent.click(within(promptNode).getByRole("button", { name: "优化" }));
    fireEvent.change(composer, { target: { value: "加入车灯在水面的暖色反射" } });
    fireEvent.click(within(promptNode).getByRole("button", { name: "优化提示词" }));
    await waitFor(() => expect(promptOutput).toHaveTextContent(secondPrompt));
    const secondCommand = invokeMock.mock.calls.filter(
      ([command]) => command === "run_prompt_node",
    )[1]?.[1] as { command: Record<string, unknown> };
    expect(secondCommand.command).toMatchObject({
      task: "optimize",
      userPrompt: "加入车灯在水面的暖色反射",
    });
    expect(secondCommand.command["contextHistory"]).toEqual(
      expect.arrayContaining([
        { role: "第 1 条 · 你", content: "雨夜站台，女孩撑伞等候列车" },
        { role: "第 2 条 · 提示词助手", content: firstPrompt },
      ]),
    );

    // 第 3 轮：再次优化，上下文继续累计为 4 条历史。
    fireEvent.change(composer, { target: { value: "镜头缓慢推近" } });
    fireEvent.click(within(promptNode).getByRole("button", { name: "优化提示词" }));
    await waitFor(() => expect(promptOutput).toHaveTextContent(thirdPrompt));
    const thirdCommand = invokeMock.mock.calls.filter(
      ([command]) => command === "run_prompt_node",
    )[2]?.[1] as { command: Record<string, unknown> };
    expect(thirdCommand.command["contextHistory"]).toEqual(
      expect.arrayContaining([
        { role: "第 1 条 · 你", content: "雨夜站台，女孩撑伞等候列车" },
        { role: "第 2 条 · 提示词助手", content: firstPrompt },
        { role: "第 3 条 · 你", content: "加入车灯在水面的暖色反射" },
        { role: "第 4 条 · 提示词助手", content: secondPrompt },
      ]),
    );
    expect(thirdCommand.command["contextHistory"]).toHaveLength(4);
  });

  it("图片素材可连入提示词节点并作为视觉理解输入传出", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        return Promise.resolve({
          optimizedPrompt: "依据参考图描述雨夜站台的提示词。",
          rawModelOutput: "依据参考图描述雨夜站台的提示词。",
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: "参考这张图，写一份雨夜站台的提示词" },
    });

    // 图片和视频同时连接，分别保留图片视觉输入和视频引用身份。
    const videoAsset = await addAssetNode("视频", "列车进站参考", 20, 700);
    connectAssetToGeneration(videoAsset, promptNode);
    expect(document.querySelectorAll(".edge--asset")).toHaveLength(1);

    const imageAsset = await addAssetNode("图片", "站台参考图", 20, 700);
    connectAssetToGeneration(imageAsset, promptNode);
    await waitFor(() => expect(document.querySelectorAll(".edge--asset")).toHaveLength(2));
    expect(within(promptNode).getByRole("list", { name: "已连入的参考素材" })).toHaveTextContent(
      "站台参考图",
    );

    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("run_prompt_node", expect.anything()),
    );
    const promptCommand = invokeMock.mock.calls.find(
      ([command]) => command === "run_prompt_node",
    )?.[1] as { command: Record<string, unknown> };
    const visionImages = promptCommand.command["visionImages"] as Array<Record<string, unknown>>;
    expect(visionImages).toHaveLength(1);
    const videoReferences = [
      {
        displayName: "列车进站参考",
        target: {
          kind: "asset",
          providerConnectionId: PROVIDER.id,
          assetId: "asset-video-1",
          canvasNodeKey: videoAsset.dataset["connectionTarget"],
          mediaType: "video",
        },
      },
    ];
    expect(promptCommand.command["referenceInputs"]).toEqual(videoReferences);
    const visionTarget = visionImages[0]!["target"] as Record<string, unknown>;
    expect(visionTarget).toMatchObject({
      kind: "asset",
      assetId: "asset-image-1",
      mediaType: "image",
    });
    expect(typeof visionTarget["providerConnectionId"]).toBe("string");
    expect(typeof visionTarget["canvasNodeKey"]).toBe("string");
    expect(visionImages[0]!["displayName"]).toBe("站台参考图");
    await waitFor(() =>
      expect(getPromptOutputEditor(promptNode)).toHaveTextContent(
        "依据参考图描述雨夜站台的提示词。",
      ),
    );

    // 解除素材连线后再次执行，视觉素材列表随之清空。
    fireEvent.click(within(promptNode).getByRole("button", { name: "解除连线：站台参考图" }));
    await waitFor(() => expect(document.querySelectorAll(".edge--asset")).toHaveLength(1));
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "run_prompt_node"),
      ).toHaveLength(2),
    );
    const secondCommand = invokeMock.mock.calls.filter(
      ([command]) => command === "run_prompt_node",
    )[1]?.[1] as { command: Record<string, unknown> };
    expect(secondCommand.command["visionImages"]).toEqual([]);
    expect(secondCommand.command["referenceInputs"]).toEqual(videoReferences);
  });

  it("已保存的图片产物可连入提示词节点并作为视觉理解输入传出", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "get_canvas_document") {
        return Promise.resolve({
          id: "canvas-scene-output-prompt",
          title: "未命名画布",
          document: {
            version: 1,
            assetNodes: [],
            genNodes: [],
            resultNodes: [],
            outputNodes: [
              {
                key: "output-prompt-image",
                resultKey: "output-prompt-task#4",
                sourceNodeId: "output-prompt-node",
                taskId: "output-prompt-task",
                mediaType: "image",
                finalPath: "C:\\generated\\prompt-ref.png",
                name: "prompt-ref.png",
                aspectRatio: 16 / 9,
                x: 40,
                y: 180,
              },
            ],
            assetEdges: [],
            view: { zoom: 74, pan: { x: 0, y: 0 } },
            prompts: {},
          },
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      if (command === "run_prompt_node") {
        return Promise.resolve({
          optimizedPrompt: "参考生成画面，重新编排镜头与光影的提示词。",
          rawModelOutput: "参考生成画面，重新编排镜头与光影的提示词。",
        });
      }
      return baseInvokeImplementation(command);
    });
    render(<App />);

    const output = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--image");
      expect(node).not.toBeNull();
      return node!;
    });
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    connectAssetToGeneration(output, promptNode);
    await waitFor(() => expect(document.querySelectorAll(".edge--asset")).toHaveLength(1));
    expect(within(promptNode).getByRole("list", { name: "已连入的参考素材" })).toHaveTextContent(
      "prompt-ref.png",
    );

    fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: "参考这张已生成的图，继续创作" },
    });
    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("run_prompt_node", expect.anything()),
    );
    const promptCommand = invokeMock.mock.calls.find(
      ([command]) => command === "run_prompt_node",
    )?.[1] as { command: Record<string, unknown> };
    const visionImages = promptCommand.command["visionImages"] as Array<Record<string, unknown>>;
    expect(visionImages).toHaveLength(1);
    expect(visionImages[0]!["target"]).toMatchObject({
      kind: "local_result",
      generationTaskId: "output-prompt-task",
      resultIndex: 4,
      canvasNodeKey: "output-prompt-image",
      mediaType: "image",
    });
    expect(visionImages[0]!["displayName"]).toBe("prompt-ref.png");
  });

  it.each([
    ["默认模式", "seedance_2_5", "参考这段生成视频，补充镜头语言"],
    ["打斗导演仅视频", "fight_prompt_master", ""],
    ["多宫格分镜仅视频", "multi_grid_storyboard", ""],
    ["故事板仅视频", "storyboard_prompt", ""],
  ])(
    "%s：已保存的视频产物可连入提示词节点并作为多模态视频素材传出",
    async (_label, mode, userPrompt) => {
      invokeMock.mockImplementation((command) => {
        if (command === "get_canvas_document") {
          return Promise.resolve({
            id: "canvas-scene-output-prompt-video",
            title: "未命名画布",
            document: {
              version: 1,
              assetNodes: [],
              genNodes: [],
              resultNodes: [],
              outputNodes: [
                {
                  key: "output-prompt-video",
                  resultKey: "output-prompt-video-task#2",
                  sourceNodeId: "output-prompt-video-node",
                  taskId: "output-prompt-video-task",
                  mediaType: "video",
                  finalPath: "C:\\generated\\prompt-motion.mp4",
                  name: "prompt-motion.mp4",
                  aspectRatio: 16 / 9,
                  x: 40,
                  y: 180,
                },
              ],
              assetEdges: [],
              view: { zoom: 74, pan: { x: 0, y: 0 } },
              prompts: {},
            },
            revision: 1,
            createdAt: 0,
            updatedAt: 0,
          });
        }
        if (command === "run_prompt_node") {
          return Promise.resolve({
            optimizedPrompt: "参考该视频片段，延续运镜与节奏写提示词。",
            rawModelOutput: "参考该视频片段，延续运镜与节奏写提示词。",
          });
        }
        return baseInvokeImplementation(command);
      });
      render(<App />);

      const output = await waitFor(() => {
        const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--video");
        expect(node).not.toBeNull();
        return node!;
      });
      const promptNode = await addPromptNode(260, 180);
      await waitFor(() =>
        expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
      );
      fireEvent.change(within(promptNode).getByLabelText("提示词技能模式"), {
        target: { value: mode },
      });
      connectAssetToGeneration(output, promptNode);
      await waitFor(() => expect(document.querySelectorAll(".edge--asset")).toHaveLength(1));
      expect(within(promptNode).getByRole("list", { name: "已连入的参考素材" })).toHaveTextContent(
        "prompt-motion.mp4",
      );

      fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
        target: { value: userPrompt },
      });
      fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("run_prompt_node", expect.anything()),
      );
      const promptCommand = invokeMock.mock.calls.find(
        ([command]) => command === "run_prompt_node",
      )?.[1] as { command: Record<string, unknown> };
      expect(promptCommand.command["mode"]).toBe(mode);
      expect(promptCommand.command["userPrompt"]).toMatch(/\S/);
      // 视频产物走多模态素材通道，不进入视觉理解图片列表。
      expect(promptCommand.command["visionImages"]).toEqual([]);
      expect(promptCommand.command["referenceInputs"]).toEqual([
        {
          target: {
            kind: "local_result",
            generationTaskId: "output-prompt-video-task",
            resultIndex: 2,
            canvasNodeKey: "output-prompt-video",
            mediaType: "video",
          },
          displayName: "prompt-motion.mp4",
        },
      ]);
    },
  );

  it("视频节点自动继承提示词节点的视觉参考图，无需重复连线即可生成", async () => {
    const generatedPrompt = "电影感环绕镜头，角色与机甲对峙，衣摆随风摆动。";
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        return Promise.resolve({
          optimizedPrompt: generatedPrompt,
          rawModelOutput: generatedPrompt,
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    fireEvent.change(within(promptNode).getByRole("textbox", { name: "创意或需求" }), {
      target: { value: "参考角色设定图，生成角色与机甲对峙的视频提示词" },
    });

    const referenceImage = await addAssetNode("图片", "站台参考图", 20, 700);
    connectAssetToGeneration(referenceImage, promptNode);
    const videoNode = await addGenerationNode("视频", 920, 520);
    connectPromptToGeneration(promptNode, videoNode);

    await waitFor(() =>
      expect(
        within(videoNode).getByRole("list", { name: "生成参考素材，按传入顺序排列" }),
      ).toHaveTextContent("站台参考图"),
    );
    expect(within(videoNode).getByText("参考素材生成")).toBeInTheDocument();
    expect(
      within(videoNode).getByRole("list", { name: "生成参考素材，按传入顺序排列" }),
    ).toHaveTextContent("站台参考图");
    expect(
      within(videoNode).getByRole("button", { name: "解除连线：站台参考图" }),
    ).toBeInTheDocument();

    fireEvent.click(within(promptNode).getByRole("button", { name: "生成提示词" }));
    await waitFor(() =>
      expect(
        within(videoNode).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      ).toHaveTextContent(generatedPrompt),
    );
    fireEvent.click(within(videoNode).getByRole("button", { name: "开始视频生成" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_generation", expect.anything()),
    );
    const command = submittedGenerationCommand();
    expect(command["operation"]).toBe("video_generation");
    expect(command["prompt"]).toEqual([{ kind: "text", text: generatedPrompt }]);
    expect(command["explicitMedia"]).toEqual([
      {
        target: {
          kind: "asset",
          providerConnectionId: "moyu-production",
          assetId: "asset-image-1",
          canvasNodeKey: referenceImage.dataset["connectionTarget"],
          mediaType: "image",
        },
        role: "reference_image",
        displayNameSnapshot: "站台参考图",
        typePosition: 1,
        contentIndex: 1,
      },
    ]);
    fireEvent.click(within(videoNode).getByRole("button", { name: "解除连线：站台参考图" }));
    await waitFor(() =>
      expect(
        within(videoNode).queryByRole("list", { name: "生成参考素材，按传入顺序排列" }),
      ).not.toBeInTheDocument(),
    );
    expect(within(promptNode).getByRole("list", { name: "已连入的参考素材" })).toHaveTextContent(
      "站台参考图",
    );
    expect(referenceImage).toBeInTheDocument();
    expect(document.querySelector(".edge--prompt-generation")).toBeNull();
  });

  it("已有连线切换 FPV 路径模式时持续传递相同参考图身份和参数", async () => {
    render(<App />);
    const promptNode = await addPromptNode(260, 180);
    await waitFor(() =>
      expect(within(promptNode).getByLabelText("提示词文本模型")).toHaveValue(TEXT_MODEL.id),
    );
    setPromptOutputText(promptNode, "沿站台向前飞行，保持连续镜头。");
    const pathImage = await addAssetNode("图片", "站台参考图", 20, 700);
    connectAssetToGeneration(pathImage, promptNode);
    const videoNode = await addGenerationNode("视频", 920, 520);
    connectPromptToGeneration(promptNode, videoNode);
    const modeSelect = within(promptNode).getByLabelText("提示词技能模式");
    const generate = within(videoNode).getByRole("button", { name: "开始视频生成" });
    const inheritedMedia = [
      {
        target: {
          kind: "asset",
          providerConnectionId: PROVIDER.id,
          assetId: "asset-image-1",
          canvasNodeKey: pathImage.dataset["connectionTarget"],
          mediaType: "image",
        },
        role: "reference_image",
        displayNameSnapshot: "站台参考图",
        typePosition: 1,
        contentIndex: 1,
      },
    ];

    expect(modeSelect).toHaveValue("seedance_2_5");
    await waitFor(() =>
      expect(
        within(videoNode).getByRole("list", { name: "生成参考素材，按传入顺序排列" }),
      ).toHaveTextContent("站台参考图"),
    );
    fireEvent.click(generate);
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    expect(submittedGenerationCommands()[0]?.["explicitMedia"]).toEqual(inheritedMedia);

    fireEvent.change(modeSelect, { target: { value: "fpv_path" } });
    await waitFor(() =>
      expect(
        within(videoNode).getByRole("list", { name: "生成参考素材，按传入顺序排列" }),
      ).toHaveTextContent("站台参考图"),
    );
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(2));
    expect(submittedGenerationCommands()[1]?.["explicitMedia"]).toEqual(inheritedMedia);

    fireEvent.change(modeSelect, { target: { value: "seedance_2_5" } });
    await waitFor(() =>
      expect(
        within(videoNode).getByRole("list", { name: "生成参考素材，按传入顺序排列" }),
      ).toHaveTextContent("站台参考图"),
    );
    expect(
      within(videoNode).getByRole("list", { name: "生成参考素材，按传入顺序排列" }),
    ).toHaveTextContent("站台参考图");
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(3));
    expect(submittedGenerationCommands()[2]?.["explicitMedia"]).toEqual(inheritedMedia);
  });

  it("保存防抖尚未到期就退出，重启后仍恢复退出前创建的节点", async () => {
    let storedDocument: unknown = null;
    let revision = 0;
    let resolveSave!: () => void;
    let delayFirstSave = true;
    invokeMock.mockImplementation((command, args) => {
      if (command === "get_canvas_document") {
        if (storedDocument == null) {
          return Promise.reject(
            Object.assign(new Error("canvas not found"), { kind: "not_found" }),
          );
        }
        return Promise.resolve({
          id: "canvas-scene-03",
          title: "未命名画布",
          document: storedDocument,
          revision,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      if (command === "save_canvas_document") {
        const saveCommand = args?.["command"] as {
          id: string;
          title: string;
          document: unknown;
        };
        const saved = delayFirstSave
          ? new Promise<void>((resolve) => {
              resolveSave = resolve;
              delayFirstSave = false;
            })
          : Promise.resolve();
        return saved.then(() => {
          storedDocument = saveCommand.document;
          revision += 1;
          return {
            ...saveCommand,
            revision,
            createdAt: 0,
            updatedAt: 0,
          };
        });
      }
      return baseInvokeImplementation(command);
    });

    const view = render(<App />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_canvas_document", {
        canvasId: "canvas-scene-03",
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const closeListenerCall = await waitFor(() => {
      const call = invokeMock.mock.calls.find(
        ([command, args]) =>
          command === "plugin:event|listen" && args?.["event"] === "tauri://close-requested",
      );
      expect(call).toBeDefined();
      return call!;
    });
    const closeHandlerId = closeListenerCall[1]?.["handler"] as number;
    const closeHandler = tauriCallbacks.get(closeHandlerId);
    expect(closeHandler).toBeDefined();

    vi.useFakeTimers();
    try {
      const template = screen.getByRole("button", { name: "拖拽创建图片生成节点" });
      dragToCanvas(template, 370, 120);
      expect(document.querySelectorAll(".canvas-gen-node--image")).toHaveLength(1);

      // 模拟用户在 1 秒自动保存防抖到期前直接退出桌面应用。
      const closePromise = closeHandler!({
        event: "tauri://close-requested",
        id: 1,
        payload: null,
      }) as Promise<unknown>;
      await act(async () => {
        await Promise.resolve();
      });
      expect(invokeMock).toHaveBeenCalledWith("save_canvas_document", expect.any(Object));
      // SQLite 尚未确认落盘时窗口必须保持存活。
      expect(invokeMock).not.toHaveBeenCalledWith("plugin:window|destroy", expect.any(Object));

      resolveSave();
      await act(async () => {
        await closePromise;
      });
      expect(invokeMock).toHaveBeenCalledWith("plugin:window|destroy", { label: "main" });
      view.unmount();
      vi.useRealTimers();
      render(<App />);
      await waitFor(() =>
        expect(document.querySelectorAll(".canvas-gen-node--image")).toHaveLength(1),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("同一个生成模板可重复拖入画布", async () => {
    render(<App />);

    const first = await addGenerationNode("图片", 370, 120);
    const second = await addGenerationNode("图片", 555, 333);

    expect(first).not.toBe(second);
    expect(document.querySelectorAll(".canvas-gen-node--image")).toHaveLength(2);
    expect(screen.getAllByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" })).toHaveLength(
      2,
    );
    expect(screen.queryByText("画布为空")).not.toBeInTheDocument();
  });

  it("素材、图片生成和视频生成投放到同一点时自动就近避让", async () => {
    render(<App />);

    const assetNode = await addAssetNode("图片", "站台参考图", 444, 296);
    const imageNode = await addGenerationNode("图片", 444, 296);
    const videoNode = await addGenerationNode("视频", 444, 296);

    console.log(
      "[dbg] asset:",
      JSON.stringify(rfNodeFlowPosition(assetNode)),
      "image:",
      JSON.stringify(rfNodeFlowPosition(imageNode)),
      "video:",
      JSON.stringify(rfNodeFlowPosition(videoNode)),
    );
    expectNodesNotToOverlap(
      assetNode,
      { width: ASSET_NODE_WIDTH, height: ASSET_NODE_HEIGHT },
      imageNode,
      {
        width: 580,
        height: 480,
      },
    );
    expectNodesNotToOverlap(
      assetNode,
      { width: ASSET_NODE_WIDTH, height: ASSET_NODE_HEIGHT },
      videoNode,
      {
        width: 580,
        height: 900,
      },
    );
    expectNodesNotToOverlap(imageNode, { width: 580, height: 480 }, videoNode, {
      width: 580,
      height: 900,
    });
  });

  it("图片和视频节点只列出供应商保存的对应类型模型", async () => {
    render(<App />);

    const imageNode = await addGenerationNode("图片", 370, 148);
    const videoNode = await addGenerationNode("视频", 703, 333);
    await waitFor(() => {
      expect(within(imageNode).getByLabelText("图片模型")).toHaveValue(IMAGE_MODEL.id);
      expect(within(videoNode).getByLabelText("视频模型")).toHaveValue(VIDEO_MODEL.id);
    });

    expect(
      within(imageNode).queryByRole("option", { name: VIDEO_MODEL.displayName }),
    ).not.toBeInTheDocument();
    expect(
      within(videoNode).queryByRole("option", { name: IMAGE_MODEL.displayName }),
    ).not.toBeInTheDocument();
    expect(
      within(within(imageNode).getByLabelText("图片模型"))
        .getAllByRole("option")
        .every((option) => !option.textContent?.includes("Seedance")),
    ).toBe(true);
    expect(
      within(within(videoNode).getByLabelText("视频模型"))
        .getAllByRole("option")
        .every((option) => !option.textContent?.includes("GPT Image")),
    ).toBe(true);
  });

  it("两个图片节点独立保存全部设置并用各自参数提交", async () => {
    render(<App />);

    const first = await addGenerationNode("图片", 370, 148);
    const second = await addGenerationNode("图片", 703, 333);

    await waitFor(() => {
      expect(within(first).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
      expect(within(second).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });

    fireEvent.change(within(first).getByLabelText("图片模型"), {
      target: { value: ALT_IMAGE_MODEL.id },
    });
    fireEvent.change(within(first).getByLabelText("尺寸"), {
      target: { value: "1024x1536" },
    });
    fireEvent.change(within(first).getByLabelText("质量"), {
      target: { value: "high" },
    });

    fireEvent.change(within(second).getByLabelText("供应商"), {
      target: { value: SECOND_PROVIDER.id },
    });
    await waitFor(() => {
      expect(within(second).getByLabelText("供应商")).toHaveValue(SECOND_PROVIDER.id);
    });
    fireEvent.change(within(second).getByLabelText("图片模型"), {
      target: { value: SECOND_IMAGE_MODEL.id },
    });
    fireEvent.change(within(second).getByLabelText("尺寸"), {
      target: { value: "1024x1024" },
    });

    expect(within(first).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    expect(within(first).getByLabelText("图片模型")).toHaveValue(ALT_IMAGE_MODEL.id);
    expect(within(first).getByRole("spinbutton", { name: "生成数量" })).toHaveValue(1);
    expect(within(first).getByLabelText("尺寸")).toHaveValue("1024x1536");
    expect(within(first).getByLabelText("质量")).toHaveValue("high");

    expect(within(second).getByLabelText("供应商")).toHaveValue(SECOND_PROVIDER.id);
    expect(within(second).getByLabelText("图片模型")).toHaveValue(SECOND_IMAGE_MODEL.id);
    expect(within(second).getByRole("spinbutton", { name: "生成数量" })).toHaveValue(1);
    expect(within(second).getByLabelText("尺寸")).toHaveValue("1024x1024");
    expect(within(second).getByLabelText("质量")).toHaveValue("standard");

    setPromptText(
      within(first).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      "第一张关键帧",
    );
    setPromptText(
      within(second).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      "第二张关键帧",
    );
    fireEvent.click(within(first).getByRole("button", { name: "开始图片生成" }));
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    fireEvent.click(within(second).getByRole("button", { name: "开始图片生成" }));
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(2));

    const commands = submittedGenerationCommands();
    expect(commands[0]).toMatchObject({
      sourceNodeId: first.dataset["connectionTarget"],
      operation: "text_to_image",
      providerConnectionId: PROVIDER.id,
      modelDefinitionId: ALT_IMAGE_MODEL.id,
      generationCount: 1,
      parameters: {
        size: "1024x1536",
        quality: "high",
      },
    });
    expect(commands[1]).toMatchObject({
      sourceNodeId: second.dataset["connectionTarget"],
      operation: "text_to_image",
      providerConnectionId: SECOND_PROVIDER.id,
      modelDefinitionId: SECOND_IMAGE_MODEL.id,
      generationCount: 1,
      parameters: {
        size: "1024x1024",
        quality: "standard",
      },
    });
  });

  it("生成数量可修改且 gpt-image 模型作为 n 参数一次请求提交", async () => {
    render(<App />);

    const imageNode = await addGenerationNode("图片", 370, 148);
    await waitFor(() => {
      expect(within(imageNode).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });

    const quantity = within(imageNode).getByRole("spinbutton", { name: "生成数量" });
    expect(quantity).not.toHaveAttribute("readonly");
    // GPT Image 契约：n 的取值范围 1~10，超出上限的输入被钳制到 10。
    fireEvent.change(quantity, { target: { value: "99" } });
    expect(quantity).toHaveValue(10);
    fireEvent.change(quantity, { target: { value: "3" } });
    expect(quantity).toHaveValue(3);

    setPromptText(
      within(imageNode).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      "站台重逢",
    );
    fireEvent.click(within(imageNode).getByRole("button", { name: "开始图片生成" }));

    // 数量 3 作为 n 参数在单个任务中一次请求提交（生成数量不再拆分任务）。
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    const command = submittedGenerationCommand();
    expect(command).toMatchObject({
      sourceNodeId: imageNode.dataset["connectionTarget"],
      operation: "text_to_image",
      providerConnectionId: PROVIDER.id,
      modelDefinitionId: IMAGE_MODEL.id,
      generationCount: 1,
    });
    expect(command["parameters"]).toMatchObject({ n: 3 });
  });

  it("不支持 n 参数的模型仍按数量拆分为多个独立任务提交", async () => {
    render(<App />);

    const imageNode = await addGenerationNode("图片", 370, 148);
    await waitFor(() => {
      expect(within(imageNode).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });

    // 切到不支持 n 的通用契约模型（photon-1，位于 luma 供应商）。
    fireEvent.change(within(imageNode).getByLabelText("供应商"), {
      target: { value: SECOND_PROVIDER.id },
    });
    await waitFor(() => {
      expect(within(imageNode).getByLabelText("供应商")).toHaveValue(SECOND_PROVIDER.id);
    });
    fireEvent.change(within(imageNode).getByLabelText("图片模型"), {
      target: { value: SECOND_IMAGE_MODEL.id },
    });
    expect(within(imageNode).getByLabelText("图片模型")).toHaveValue(SECOND_IMAGE_MODEL.id);
    const quantity = within(imageNode).getByRole("spinbutton", { name: "生成数量" });
    // 无 n 参数时沿用任务拆分上限 4。
    expect(quantity).toHaveAttribute("max", "4");
    fireEvent.change(quantity, { target: { value: "3" } });
    expect(quantity).toHaveValue(3);

    setPromptText(
      within(imageNode).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      "站台重逢",
    );
    fireEvent.click(within(imageNode).getByRole("button", { name: "开始图片生成" }));

    // 数量 3 拆分为 3 个任务，每个任务数量固定为 1（供应商 API 无数量参数）。
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(3));
    for (const command of submittedGenerationCommands()) {
      expect(command).toMatchObject({
        sourceNodeId: imageNode.dataset["connectionTarget"],
        operation: "text_to_image",
        providerConnectionId: SECOND_PROVIDER.id,
        modelDefinitionId: SECOND_IMAGE_MODEL.id,
        generationCount: 1,
      });
      expect(command["parameters"]).not.toHaveProperty("n");
    }
  });

  it("图片输入切换操作后保留不兼容模型并在节点内阻止提交", async () => {
    render(<App />);

    const imageGeneration = await addGenerationNode("图片", 555, 222);
    await waitFor(() => {
      expect(within(imageGeneration).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });
    fireEvent.change(within(imageGeneration).getByLabelText("图片模型"), {
      target: { value: TEXT_ONLY_IMAGE_MODEL.id },
    });

    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, imageGeneration);
    expect(await within(imageGeneration).findByText("图片参考生成")).toBeInTheDocument();
    expect(within(imageGeneration).getByLabelText("图片模型")).toHaveValue(
      TEXT_ONLY_IMAGE_MODEL.id,
    );
    expect(within(imageGeneration).getByRole("option", { name: /不支持当前操作/ })).toHaveValue(
      TEXT_ONLY_IMAGE_MODEL.id,
    );

    setPromptText(
      within(imageGeneration).getByRole("textbox", {
        name: "提示词输入框，输入 @ 引用素材",
      }),
      "生成参考图片",
    );
    fireEvent.click(within(imageGeneration).getByRole("button", { name: "开始图片生成" }));

    expect(await screen.findByLabelText("发起任务失败")).toHaveTextContent("不支持图片参考生成");
    expect(submittedGenerationCommands()).toHaveLength(0);
  });

  it("两个视频节点独立保存各自设置并用各自参数提交", async () => {
    render(<App />);

    const first = await addGenerationNode("视频", 370, 148);
    const second = await addGenerationNode("视频", 703, 333);

    await waitFor(() => {
      expect(within(first).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
      expect(within(second).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });

    fireEvent.change(within(first).getByLabelText("视频模型"), {
      target: { value: ALT_VIDEO_MODEL.id },
    });
    fireEvent.change(within(first).getByLabelText("画幅"), { target: { value: "9:16" } });
    fireEvent.change(within(first).getByLabelText("分辨率"), {
      target: { value: "480p" },
    });
    fireEvent.change(within(first).getByLabelText("时长"), { target: { value: "5" } });
    fireEvent.click(within(first).getByRole("checkbox", { name: "生成音频" }));
    fireEvent.change(within(first).getByLabelText("输出格式"), { target: { value: "mov" } });
    fireEvent.change(within(first).getByLabelText("任务类型"), { target: { value: "edit" } });
    const originalVideo = await addAssetNode("视频", "列车进站参考", 148, 148);
    connectAssetToGeneration(originalVideo, first);

    fireEvent.change(within(second).getByLabelText("视频模型"), {
      target: { value: ALT_VIDEO_MODEL.id },
    });
    fireEvent.change(within(second).getByLabelText("供应商"), {
      target: { value: SECOND_PROVIDER.id },
    });
    await waitFor(() => {
      expect(within(second).getByLabelText("供应商")).toHaveValue(SECOND_PROVIDER.id);
    });
    expect(within(second).getByLabelText("视频模型")).toHaveValue(VIDEO_MODEL.id);
    expect(within(second).queryByRole("option", { name: /不可用/ })).not.toBeInTheDocument();
    fireEvent.change(within(second).getByLabelText("视频模型"), {
      target: { value: SECOND_VIDEO_MODEL.id },
    });
    fireEvent.change(within(second).getByLabelText("画幅"), { target: { value: "1:1" } });
    fireEvent.change(within(second).getByLabelText("时长"), { target: { value: "12" } });

    expect(within(first).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    expect(within(first).getByLabelText("视频模型")).toHaveValue(ALT_VIDEO_MODEL.id);
    expect(within(first).getByRole("spinbutton", { name: "生成数量" })).toHaveValue(1);
    expect(within(first).getByLabelText("画幅")).toHaveValue("adaptive");
    expect(within(first).getByLabelText("画幅")).toBeDisabled();
    expect(within(first).getByLabelText("分辨率")).toHaveValue("480p");
    expect(within(first).getByLabelText("时长")).toHaveValue("-1");
    expect(within(first).getByLabelText("时长")).toBeDisabled();
    expect(within(first).getByRole("checkbox", { name: "生成音频" })).not.toBeChecked();
    expect(within(first).getByLabelText("输出格式")).toHaveValue("mov");
    expect(within(first).getByLabelText("任务类型")).toHaveValue("edit");

    expect(within(second).getByLabelText("供应商")).toHaveValue(SECOND_PROVIDER.id);
    expect(within(second).getByLabelText("视频模型")).toHaveValue(SECOND_VIDEO_MODEL.id);
    expect(within(second).getByRole("spinbutton", { name: "生成数量" })).toHaveValue(1);
    expect(within(second).getByLabelText("画幅")).toHaveValue("1:1");
    expect(within(second).getByLabelText("分辨率")).toHaveValue("720p");
    expect(within(second).getByLabelText("时长")).toHaveValue("12");
    expect(within(second).getByRole("checkbox", { name: "生成音频" })).toBeChecked();

    setPromptText(
      within(first).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      "编辑视频，去掉第一个镜头中的路人",
    );
    setPromptText(
      within(second).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      "第二个镜头",
    );
    fireEvent.click(within(first).getByRole("button", { name: "开始视频生成" }));
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    fireEvent.click(within(second).getByRole("button", { name: "开始视频生成" }));
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(2));

    const commands = submittedGenerationCommands();
    const firstCommand = commands[0]!;
    const secondCommand = commands[1]!;
    expect(firstCommand).toMatchObject({
      sourceNodeId: first.dataset["connectionTarget"],
      providerConnectionId: PROVIDER.id,
      modelDefinitionId: ALT_VIDEO_MODEL.id,
      generationCount: 1,
      videoTaskType: "edit",
      parameters: {
        ratio: "adaptive",
        resolution: "480p",
        duration: -1,
        generate_audio: false,
        output_format: "mov",
        omni_reference_task_type: "edit",
      },
    });
    expect(secondCommand).toMatchObject({
      sourceNodeId: second.dataset["connectionTarget"],
      providerConnectionId: SECOND_PROVIDER.id,
      modelDefinitionId: SECOND_VIDEO_MODEL.id,
      generationCount: 1,
      parameters: {
        ratio: "1:1",
        resolution: "720p",
        duration: 12,
        generate_audio: true,
      },
    });
    expect(secondCommand["parameters"]).not.toHaveProperty("output_format");
    expect(secondCommand["parameters"]).not.toHaveProperty("omni_reference_task_type");
  });

  it.each([VIDEO_MODEL.id, "dreamina-seedance-2.5"])(
    "Seedance 任务切换对 %s 提交正确字段并前置阻止缺视频",
    async (modelId) => {
      if (modelId.startsWith("dreamina")) {
        invokeMock.mockImplementation(async (command, args) => {
          const value = await baseInvokeImplementation(command, args);
          if (command === "list_model_definitions")
            return [
              ...(value as unknown[]),
              {
                ...VIDEO_MODEL,
                id: modelId,
                displayName: modelId,
                remoteModelId: modelId,
                operations: defaultModelOperationSchema(modelId, ["video_generation"]),
              },
            ];
          if (command === "list_provider_model_bindings")
            return [...(value as unknown[]), { ...VIDEO_BINDING, modelDefinitionId: modelId }];
          return value;
        });
      }
      render(<App />);
      const node = await addGenerationNode("视频", 555, 222);
      await waitFor(() => expect(within(node).getByLabelText("供应商")).toHaveValue(PROVIDER.id));
      fireEvent.change(within(node).getByLabelText("视频模型"), { target: { value: modelId } });
      fireEvent.change(within(node).getByLabelText("画幅"), { target: { value: "9:16" } });
      fireEvent.change(within(node).getByLabelText("时长"), { target: { value: "10" } });
      fireEvent.change(within(node).getByLabelText("任务类型"), { target: { value: "edit" } });
      setPromptText(
        within(node).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
        "编辑视频，去掉画面里的路人",
      );
      const generate = within(node).getByRole("button", { name: "开始视频生成" });
      fireEvent.click(generate);
      expect(submittedGenerationCommands()).toHaveLength(0);
      expect(await screen.findByLabelText("发起任务失败")).toHaveTextContent(
        "请连接至少 1 个待编辑的视频",
      );
      const originalVideo = await addAssetNode("视频", "列车进站参考", 148, 148);
      connectAssetToGeneration(originalVideo, node);
      fireEvent.click(generate);
      await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
      expect(submittedGenerationCommands()[0]).toMatchObject({
        videoTaskType: "edit",
        parameters: { ratio: "adaptive", duration: -1 },
        explicitMedia: [
          {
            role: "reference_video",
            target: { canvasNodeKey: originalVideo.dataset["connectionTarget"] },
          },
        ],
      });
      if (modelId.startsWith("dreamina"))
        expect(submittedGenerationCommands()[0]!["parameters"]).not.toHaveProperty(
          "omni_reference_task_type",
        );
      else
        expect(submittedGenerationCommands()[0]!["parameters"]).toHaveProperty(
          "omni_reference_task_type",
          "edit",
        );
      await waitFor(() => expect(generate).toBeEnabled());
      fireEvent.change(within(node).getByLabelText("任务类型"), { target: { value: "extend" } });
      fireEvent.change(within(node).getByLabelText("时长"), { target: { value: "8" } });
      setPromptText(
        within(node).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
        "向后延长视频，列车继续驶入站台",
      );
      fireEvent.click(generate);
      await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(2));
      expect(submittedGenerationCommands()[1]).toMatchObject({
        videoTaskType: "extend",
        parameters: { ratio: "adaptive", duration: 8 },
      });
      if (modelId.startsWith("dreamina"))
        expect(submittedGenerationCommands()[1]!["parameters"]).not.toHaveProperty(
          "omni_reference_task_type",
        );
      else
        expect(submittedGenerationCommands()[1]!["parameters"]).toHaveProperty(
          "omni_reference_task_type",
          "extend",
        );
    },
  );

  it("Seedance 首尾帧将稳定素材身份映射为首帧尾帧，并阻止混入参考视频", async () => {
    render(<App />);
    const node = await addGenerationNode("视频", 555, 222);
    const firstImage = await addAssetNode("图片", "站台参考图", 148, 148);
    const lastImage = await addAssetNode("图片", "站台参考图", 148, 333);
    connectAssetToGeneration(firstImage, node);
    connectAssetToGeneration(lastImage, node);
    fireEvent.change(within(node).getByLabelText("任务类型"), {
      target: { value: "first_last_frame" },
    });
    fireEvent.click(within(node).getByRole("button", { name: "交换首尾帧" }));
    setPromptText(
      within(node).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
      "镜头从首帧平稳过渡到尾帧",
    );
    const generate = within(node).getByRole("button", { name: "开始视频生成" });
    fireEvent.click(generate);
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    expect(submittedGenerationCommands()[0]).toMatchObject({
      videoTaskType: "first_last_frame",
      parameters: { ratio: "adaptive" },
      explicitMedia: [
        { role: "last_frame", target: { canvasNodeKey: firstImage.dataset["connectionTarget"] } },
        { role: "first_frame", target: { canvasNodeKey: lastImage.dataset["connectionTarget"] } },
      ],
    });
    expect(submittedGenerationCommands()[0]!["parameters"]).not.toHaveProperty(
      "omni_reference_task_type",
    );
    await waitFor(() => expect(generate).toBeEnabled());
    const originalVideo = await addAssetNode("视频", "列车进站参考", 148, 518);
    connectAssetToGeneration(originalVideo, node);
    fireEvent.click(generate);
    expect(await screen.findByLabelText("发起任务失败")).toHaveTextContent(
      "需要且只能连接 2 张图片",
    );
    expect(submittedGenerationCommands()).toHaveLength(1);
  });

  it.each([
    {
      label: "云素材原视频",
      source: "cloud",
      src: "https://cdn.example.com/no-cors-video.mp4",
      target: { kind: "asset", providerConnectionId: "luma-production", assetId: "source-video" },
    },
    {
      label: "云素材签名视频",
      source: "cloud",
      src: "https://tos-cn.example.com/video.mp4?X-Tos-Signature=expired",
      target: { kind: "asset", providerConnectionId: "luma-production", assetId: "source-video" },
    },
    {
      label: "云素材缺少预览",
      source: "cloud",
      src: null,
      target: { kind: "asset", providerConnectionId: "luma-production", assetId: "source-video" },
    },
    {
      label: "本地素材对象存储视频",
      source: "local",
      src: "https://objects.example.com/staged-video.mp4",
      target: { kind: "local_asset", stagingJobId: "source-video" },
    },
    {
      label: "本地素材缺少预览",
      source: "local",
      src: null,
      target: { kind: "local_asset", stagingJobId: "source-video" },
    },
    {
      label: "生成产物视频",
      source: "generation",
      src: "C:\\generated\\source-video.mp4",
      target: { kind: "local_result", generationTaskId: "source-task", resultIndex: 0 },
    },
    {
      label: "下载产物视频",
      source: "download",
      src: "C:\\downloads\\source-video.mp4",
      target: { kind: "local_file", path: "C:\\downloads\\source-video.mp4" },
    },
    {
      label: "合成产物视频",
      source: "composition",
      src: "C:\\compositions\\source-video.mp4",
      target: { kind: "local_file", path: "C:\\compositions\\source-video.mp4" },
    },
  ] as const)(
    "局部编辑按稳定来源解析 $label，不依赖封面或跨域预览",
    async ({ label, source, src, target }) => {
      const isAsset = source === "cloud" || source === "local";
      invokeMock.mockImplementation((command, args) => {
        if (command === "get_canvas_document")
          return Promise.resolve({
            id: "canvas-scene-03",
            title: "未命名画布",
            revision: 1,
            createdAt: 0,
            updatedAt: 0,
            document: {
              version: 1,
              assetNodes: isAsset
                ? [
                    {
                      key: "source-node",
                      assetId: "source-video",
                      providerConnectionId: "luma-production",
                      source,
                      kind: "video",
                      name: label,
                      previewUrl: src == null ? null : "https://cdn.example.com/cover.jpg",
                      videoUrl: src,
                      x: 40,
                      y: 180,
                    },
                  ]
                : [],
              outputNodes: isAsset
                ? []
                : [
                    {
                      key: "source-node",
                      resultKey: "source-task#0",
                      sourceNodeId: "old-node",
                      taskId: "source-task",
                      mediaType: "video",
                      origin: source,
                      finalPath: src,
                      name: label,
                      aspectRatio: 16 / 9,
                      x: 40,
                      y: 180,
                    },
                  ],
              genNodes: [],
              resultNodes: [],
              assetEdges: [],
              view: { zoom: 74, pan: { x: 0, y: 0 } },
              prompts: {},
            },
          });
        return baseInvokeImplementation(command, args);
      });
      render(<App />);
      const original = await waitFor(() => {
        const found = document.querySelector<HTMLElement>(
          isAsset ? '[data-connection-target="source-node"]' : ".canvas-asset-node--output--video",
        );
        expect(found).not.toBeNull();
        return found!;
      });
      const node = await addGenerationNode("视频", 555, 222);
      connectAssetToGeneration(original, node);
      fireEvent.change(within(node).getByLabelText("任务类型"), { target: { value: "edit" } });
      fireEvent.click(within(node).getByRole("button", { name: `局部消除与编辑 · ${label}` }));
      expect(
        await screen.findByRole("button", { name: `应用测试局部标注 · ${label}` }),
      ).toBeInTheDocument();
      const expectedTarget: MediaReferenceTarget = {
        ...target,
        canvasNodeKey: "source-node",
        mediaType: "video",
      };
      expect(videoLocalEditSourceMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          key: "source-node",
          label,
          target: expectedTarget,
        }),
      );
      if (isAsset) {
        expect(videoLocalEditSourceMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            src: src ?? "",
          }),
        );
      }
      expect(submittedGenerationCommands()).toHaveLength(0);
    },
  );

  it("云端图片素材节点预览签名过期时向后端续签一次，用新地址重新加载", async () => {
    const staleUrl = "https://tos-cn.example.com/stale.jpg?X-Tos-Signature=expired";
    const freshUrl = "https://tos-cn.example.com/fresh.jpg?X-Tos-Signature=fresh";
    invokeMock.mockImplementation((command, args) => {
      if (command === "get_canvas_document")
        return Promise.resolve({
          id: "canvas-scene-04",
          title: "未命名画布",
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
          document: {
            version: 1,
            assetNodes: [
              {
                key: "stale-image-node",
                assetId: "image-asset-1",
                providerConnectionId: "luma-production",
                source: "cloud",
                kind: "image",
                name: "过期签名图片",
                previewUrl: staleUrl,
                videoUrl: null,
                x: 40,
                y: 180,
              },
            ],
            outputNodes: [],
            genNodes: [],
            resultNodes: [],
            assetEdges: [],
            view: { zoom: 74, pan: { x: 0, y: 0 } },
            prompts: {},
          },
        });
      if (command === "refresh_asset_media") return Promise.resolve(freshUrl);
      return baseInvokeImplementation(command, args);
    });
    render(<App />);
    const node = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-connection-target="stale-image-node"]',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    const image = node.querySelector("img");
    expect(image).toHaveAttribute(
      "src",
      `asset://localhost/video?src=${encodeURIComponent(staleUrl)}`,
    );

    // 旧签名过期：加载失败后按素材身份向后端续签一次，节点数据回写新地址。
    fireEvent.error(image!);
    await waitFor(() => {
      const refreshed = node.querySelector("img");
      expect(refreshed).toHaveAttribute(
        "src",
        `asset://localhost/video?src=${encodeURIComponent(freshUrl)}`,
      );
    });
    const refreshCalls = invokeMock.mock.calls.filter(([name]) => name === "refresh_asset_media");
    expect(refreshCalls).toHaveLength(1);
    expect((refreshCalls[0]![1] as { command: unknown }).command).toEqual({
      providerConnectionId: "luma-production",
      id: "image-asset-1",
      mediaType: "image",
    });

    // 新地址仍失败时不再续签（每节点实例一次），避免循环请求。
    fireEvent.error(node.querySelector("img")!);
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([name]) => name === "refresh_asset_media")).toHaveLength(
        1,
      );
    });
  });

  it("云端视频素材节点播放签名过期时同样触发续签并回写播放地址", async () => {
    const staleVideoUrl = "https://tos-cn.example.com/stale.mp4?X-Tos-Signature=expired";
    const freshVideoUrl = "https://tos-cn.example.com/fresh.mp4?X-Tos-Signature=fresh";
    invokeMock.mockImplementation((command, args) => {
      if (command === "get_canvas_document")
        return Promise.resolve({
          id: "canvas-scene-05",
          title: "未命名画布",
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
          document: {
            version: 1,
            assetNodes: [
              {
                key: "stale-video-node",
                assetId: "video-asset-1",
                providerConnectionId: "luma-production",
                source: "cloud",
                kind: "video",
                name: "过期签名视频",
                previewUrl: staleVideoUrl,
                videoUrl: staleVideoUrl,
                x: 40,
                y: 180,
              },
            ],
            outputNodes: [],
            genNodes: [],
            resultNodes: [],
            assetEdges: [],
            view: { zoom: 74, pan: { x: 0, y: 0 } },
            prompts: {},
          },
        });
      if (command === "refresh_asset_media") return Promise.resolve(freshVideoUrl);
      return baseInvokeImplementation(command, args);
    });
    render(<App />);
    const node = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-connection-target="stale-video-node"]',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    const video = node.querySelector("video");
    expect(video).toHaveAttribute(
      "src",
      `asset://localhost/video?src=${encodeURIComponent(staleVideoUrl)}`,
    );

    fireEvent.error(video!);
    await waitFor(() => {
      const refreshed = node.querySelector("video");
      expect(refreshed).toHaveAttribute(
        "src",
        `asset://localhost/video?src=${encodeURIComponent(freshVideoUrl)}`,
      );
    });
    const refreshCalls = invokeMock.mock.calls.filter(([name]) => name === "refresh_asset_media");
    expect(refreshCalls).toHaveLength(1);
    expect((refreshCalls[0]![1] as { command: unknown }).command).toEqual({
      providerConnectionId: "luma-production",
      id: "video-asset-1",
      mediaType: "video",
    });
  });

  it("视频局部标注保存为独立素材，并将原视频与标注图稳定引用提交到编辑任务", async () => {
    let savedDocument: CanvasDocumentV2 | null = null;
    invokeMock.mockImplementation((command, args) => {
      if (command === "get_canvas_document")
        return Promise.resolve({
          id: "canvas-scene-03",
          title: "未命名画布",
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
          document: {
            version: 1,
            assetNodes: [],
            genNodes: [],
            resultNodes: [],
            assetEdges: [],
            outputNodes: [
              {
                key: "restored-video",
                resultKey: "restored-task#0",
                sourceNodeId: "old-node",
                taskId: "restored-task",
                mediaType: "video",
                finalPath: "C:\\generated\\original.mp4",
                name: "原视频.mp4",
                aspectRatio: 16 / 9,
                x: 40,
                y: 180,
              },
            ],
            view: { zoom: 74, pan: { x: 0, y: 0 } },
            prompts: {},
          },
        });
      if (command === "save_video_edit_frame")
        return Promise.resolve({
          path: "C:\\generated\\annotation.png",
          width: 1920,
          height: 1080,
        });
      if (command === "save_canvas_document")
        savedDocument = (args?.["command"] as SaveCanvasDocumentCommand)
          .document as CanvasDocumentV2;
      return baseInvokeImplementation(command, args);
    });
    render(<App />);
    const restored = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".canvas-asset-node--output--video");
      expect(found).not.toBeNull();
      return found!;
    });
    const node = await addGenerationNode("视频", 555, 222);
    connectAssetToGeneration(restored, node);
    fireEvent.change(within(node).getByLabelText("任务类型"), { target: { value: "edit" } });
    fireEvent.click(within(node).getByRole("button", { name: "局部消除与编辑 · 原视频.mp4" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用测试局部标注 · 原视频.mp4" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_video_edit_frame", {
        imageDataUrl: "data:image/png;base64,c2FtcGxl",
      }),
    );
    expect(
      await within(node).findByRole("button", { name: "解除连线：原视频.mp4 · 2.250s 标注" }),
    ).toBeInTheDocument();
    const prompt = within(node).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" });
    expect(prompt).toHaveTextContent("删除标记区域中的路人");
    expect(prompt.querySelectorAll(".mention-chip")).toHaveLength(2);
    await waitFor(
      () => {
        expect(
          savedDocument?.outputNodes?.find((output) => output.origin === "video_edit"),
        ).toMatchObject({
          finalPath: "C:\\generated\\annotation.png",
          sourceNodeId: "restored-video",
          mediaType: "image",
        });
      },
      { timeout: 4000 },
    );
    const annotation = savedDocument!.outputNodes!.find(
      (output) => output.origin === "video_edit",
    )!;
    expect(savedDocument!.assetEdges).toContainEqual(
      expect.objectContaining({ fromKey: annotation.key, toKey: node.dataset["connectionTarget"] }),
    );
    fireEvent.click(within(node).getByRole("button", { name: "开始视频生成" }));
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    expect(submittedGenerationCommands()[0]).toMatchObject({
      videoTaskType: "edit",
      parameters: { ratio: "adaptive", duration: -1 },
      explicitMedia: [
        {
          role: "reference_video",
          target: { canvasNodeKey: "restored-video", mediaType: "video" },
        },
        {
          role: "reference_image",
          target: {
            kind: "local_file",
            path: "C:\\generated\\annotation.png",
            canvasNodeKey: annotation.key,
            mediaType: "image",
          },
        },
      ],
    });
  });

  it("恢复含上游提示词的局部编辑画布时保留编辑指令与原视频标注图稳定引用", async () => {
    let storedDocument: CanvasDocumentV2 | null = null;
    invokeMock.mockImplementation((command, args) => {
      if (command === "get_canvas_document" && storedDocument)
        return Promise.resolve({
          id: "canvas-scene-03",
          title: "未命名画布",
          document: structuredClone(storedDocument),
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      if (command === "save_canvas_document") {
        const save = args?.["command"] as SaveCanvasDocumentCommand;
        storedDocument = structuredClone(save.document) as CanvasDocumentV2;
        return Promise.resolve({ ...save, revision: 1, createdAt: 0, updatedAt: 0 });
      }
      if (command === "save_video_edit_frame")
        return Promise.resolve({
          path: "C:\\generated\\restored-annotation.png",
          width: 1920,
          height: 1080,
        });
      return baseInvokeImplementation(command, args);
    });
    const view = render(<App />);
    const sourcePrompt = await addPromptNode(260, 180);
    setPromptOutputText(sourcePrompt, "上游要求：保留列车进站镜头");
    const node = await addGenerationNode("视频", 920, 180);
    const original = await addAssetNode("视频", "列车进站参考", 20, 500);
    connectAssetToGeneration(original, node);
    connectPromptToGeneration(sourcePrompt, node);
    const prompt = within(node).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" });
    await waitFor(() => expect(prompt).toHaveTextContent("上游要求：保留列车进站镜头"));
    fireEvent.change(within(node).getByLabelText("任务类型"), { target: { value: "edit" } });
    fireEvent.click(within(node).getByRole("button", { name: "局部消除与编辑 · 列车进站参考" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用测试局部标注 · 列车进站参考" }));
    await waitFor(() => expect(prompt).toHaveTextContent("删除标记区域中的路人"));
    const nodeKey = node.dataset["connectionTarget"]!;
    const originalKey = original.dataset["connectionTarget"]!;
    const originalMentions = Array.from(prompt.querySelectorAll<HTMLElement>(".mention-chip")).map(
      (chip) => ({ mentionId: chip.dataset["mentionId"], nodeKey: chip.dataset["canvasNodeKey"] }),
    );
    expect(originalMentions).toHaveLength(2);
    await waitFor(
      () => {
        expect(
          storedDocument?.promptContents[nodeKey]?.items.filter(
            (item) => item.kind === "media_reference",
          ),
        ).toHaveLength(2);
        expect(
          storedDocument?.outputNodes?.find((output) => output.origin === "video_edit"),
        ).toBeDefined();
      },
      { timeout: 4000 },
    );
    const annotationKey = storedDocument!.outputNodes!.find(
      (output) => output.origin === "video_edit",
    )!.key;
    view.unmount();
    render(<App />);
    const restoredNode = await waitFor(() => {
      const restored = document.querySelector<HTMLElement>(`[data-connection-target="${nodeKey}"]`);
      expect(restored).not.toBeNull();
      return restored!;
    });
    await waitForNodeAccessible(restoredNode);
    const restoredPrompt = within(restoredNode).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    await waitFor(() => expect(restoredPrompt).toHaveTextContent("删除标记区域中的路人"));
    expect(restoredPrompt).toHaveTextContent("上游要求：保留列车进站镜头");
    expect(
      Array.from(restoredPrompt.querySelectorAll<HTMLElement>(".mention-chip")).map((chip) => ({
        mentionId: chip.dataset["mentionId"],
        nodeKey: chip.dataset["canvasNodeKey"],
      })),
    ).toEqual(originalMentions);
    expect(within(restoredNode).getByLabelText("任务类型")).toHaveValue("edit");
    fireEvent.click(within(restoredNode).getByRole("button", { name: "开始视频生成" }));
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    const command = submittedGenerationCommands()[0]!;
    expect(command).toMatchObject({
      videoTaskType: "edit",
      parameters: { ratio: "adaptive", duration: -1 },
      explicitMedia: [
        {
          role: "reference_video",
          target: { canvasNodeKey: originalKey, assetId: "asset-video-1" },
        },
        {
          role: "reference_image",
          target: {
            kind: "local_file",
            path: "C:\\generated\\restored-annotation.png",
            canvasNodeKey: annotationKey,
          },
        },
      ],
    });
    const segments = command["prompt"] as readonly {
      kind: string;
      text?: string;
      mentionId?: string;
    }[];
    expect(
      segments
        .filter((segment) => segment.kind === "text")
        .map((segment) => segment.text)
        .join(""),
    ).toContain("删除标记区域中的路人");
    expect(
      segments
        .filter((segment) => segment.kind === "media_reference")
        .map((segment) => segment.mentionId),
    ).toEqual(originalMentions.map((mention) => mention.mentionId));
  });

  it("编辑要求里的 @ 引用断开后拒绝提交，不把孤立引用写进节点提示词", async () => {
    invokeMock.mockImplementation((command, args) => {
      if (command === "save_video_edit_frame")
        return Promise.resolve({
          path: "C:\\generated\\orphan-annotation.png",
          width: 1920,
          height: 1080,
        });
      return baseInvokeImplementation(command, args);
    });
    videoLocalEditInstructionMock.document = {
      schema: "prompt-content",
      version: 1,
      items: [
        { kind: "text", text: "去掉，改为" },
        {
          kind: "media_reference",
          mentionId: "mention-orphan",
          canvasNodeKey: "missing-image",
          target: {
            kind: "asset",
            providerConnectionId: "luma-production",
            assetId: "asset-missing",
            canvasNodeKey: "missing-image",
            mediaType: "image",
          },
          displayNameSnapshot: "幽灵图.png",
        },
      ],
    };
    render(<App />);
    const node = await addGenerationNode("视频", 920, 180);
    const original = await addAssetNode("视频", "列车进站参考", 20, 500);
    connectAssetToGeneration(original, node);
    fireEvent.change(within(node).getByLabelText("任务类型"), { target: { value: "edit" } });
    fireEvent.click(within(node).getByRole("button", { name: "局部消除与编辑 · 列车进站参考" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用测试局部标注 · 列车进站参考" }));

    expect(await screen.findByText(/编辑要求引用的素材已断开连接/)).toBeInTheDocument();
    expect(
      within(node).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" }),
    ).not.toHaveTextContent("去掉，改为");
    expect(submittedGenerationCommands()).toHaveLength(0);
  });

  it("已有空能力快照的 Wan 3.0 模型仍在视频节点显示完整请求参数", async () => {
    invokeMock.mockImplementation(async (command) => {
      const value = await baseInvokeImplementation(command);
      if (command === "list_model_definitions") {
        return [...(value as unknown[]), STALE_WAN_VIDEO_MODEL];
      }
      if (command === "list_provider_model_bindings") {
        return [...(value as unknown[]), STALE_WAN_VIDEO_BINDING];
      }
      return value;
    });
    render(<App />);

    const videoGeneration = await addGenerationNode("视频", 555, 222);
    await waitFor(() => {
      expect(within(videoGeneration).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });
    fireEvent.change(within(videoGeneration).getByLabelText("视频模型"), {
      target: { value: STALE_WAN_VIDEO_MODEL.id },
    });

    expect(within(videoGeneration).getByLabelText("分辨率")).toHaveValue("1080P");
    expect(within(videoGeneration).getByLabelText("画幅")).toHaveValue("adaptive");
    expect(within(videoGeneration).getByLabelText("时长")).toHaveValue("5");
    expect(within(videoGeneration).getByRole("spinbutton", { name: "随机种子" })).toHaveValue(null);
    expect(within(videoGeneration).getByRole("checkbox", { name: "添加水印" })).not.toBeChecked();
  });

  it("联网搜索只在兼容模型且无媒体输入时随视频节点提交", async () => {
    render(<App />);

    const videoGeneration = await addGenerationNode("视频", 555, 222);
    await waitFor(() => {
      expect(within(videoGeneration).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });

    fireEvent.change(within(videoGeneration).getByLabelText("视频模型"), {
      target: { value: FAST_VIDEO_MODEL.id },
    });
    const webSearch = within(videoGeneration).getByRole("checkbox", { name: "联网搜索" });
    expect(webSearch).toBeEnabled();
    expect(within(videoGeneration).queryByLabelText("输出格式")).not.toBeInTheDocument();
    expect(within(videoGeneration).queryByLabelText("任务类型")).not.toBeInTheDocument();
    fireEvent.click(webSearch);

    setPromptText(
      within(videoGeneration).getByRole("textbox", {
        name: "提示词输入框，输入 @ 引用素材",
      }),
      "联网查找最新街景后生成镜头",
    );
    const generate = within(videoGeneration).getByRole("button", {
      name: "开始视频生成",
    });
    fireEvent.click(generate);
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    expect(submittedGenerationCommands()[0]).toMatchObject({
      providerConnectionId: PROVIDER.id,
      modelDefinitionId: FAST_VIDEO_MODEL.id,
      parameters: {
        web_search: true,
      },
    });

    await waitFor(() => expect(generate).toBeEnabled());
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    await waitFor(() => expect(webSearch).toBeDisabled());
    expect(webSearch).not.toBeChecked();

    fireEvent.click(generate);
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(2));
    expect(submittedGenerationCommands()[1]!["parameters"]).not.toHaveProperty("web_search");
  });

  it("Seedance 2.0 视频节点也提供「智能时长」选项", async () => {
    render(<App />);

    const videoGeneration = await addGenerationNode("视频", 555, 222);
    await waitFor(() => {
      expect(within(videoGeneration).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });
    fireEvent.change(within(videoGeneration).getByLabelText("视频模型"), {
      target: { value: FAST_VIDEO_MODEL.id },
    });

    expect(within(videoGeneration).getByRole("option", { name: "智能时长" })).toBeInTheDocument();
  });

  it("任务启动即落占位产物卡片，进行中展示任务状态与进度", async () => {
    // 任务列表始终返回 running 38% 的任务：提交后占位卡片原地展示进行状态。
    const runningTask = makeTaskSummary({ status: "running", progress: 38 });
    invokeMock.mockImplementation((command) => {
      if (command === "list_generation_tasks") {
        return Promise.resolve({ items: [runningTask], nextCursorCreatedBefore: null });
      }
      return baseInvokeImplementation(command);
    });
    render(<App />);

    const videoGeneration = await addGenerationNode("视频", 555, 222);
    await waitFor(() => {
      expect(within(videoGeneration).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });
    setPromptText(
      within(videoGeneration).getByRole("textbox", {
        name: "提示词输入框，输入 @ 引用素材",
      }),
      "夜色中的城市街景俯拍镜头",
    );
    fireEvent.click(within(videoGeneration).getByRole("button", { name: "开始视频生成" }));

    // 占位卡片立即创建并承担原任务状态栏职责。
    const outputCard = await screen.findByText("生成中 · 38%");
    const card = outputCard.closest<HTMLElement>(".canvas-asset-node--output")!;
    expect(card).toBeInTheDocument();
    expect(card).toHaveClass("canvas-asset-node--output--video");
    expect(card).not.toHaveClass("canvas-asset-node--output--failed");
    expect(card).toHaveAttribute("aria-busy", "true");
    const progress = within(card).getByRole("progressbar", { name: "视频生成进度" });
    expect(progress).toHaveAttribute("aria-valuemin", "0");
    expect(progress).toHaveAttribute("aria-valuemax", "100");
    // <progress> 的 value 是 number，toHaveValue 需传数字而非字符串。
    expect(progress).toHaveValue(38);
    // 与来源生成节点之间的虚线连线同步出现。
    expect(document.querySelector(".edge--gen-output")).not.toBeNull();
  });

  it("点击已生成的产物卡片后全屏浏览源媒体", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "get_canvas_document") {
        return Promise.resolve({
          id: "canvas-scene-03",
          title: "未命名画布",
          document: {
            version: 1,
            assetNodes: [],
            genNodes: [],
            resultNodes: [],
            outputNodes: [
              {
                key: "output-task-1",
                resultKey: "task-1#0",
                sourceNodeId: "gen-node-1",
                taskId: "task-1",
                mediaType: "image",
                finalPath: "C:\\generated\\night-train.png",
                name: "night-train.png",
                aspectRatio: 16 / 9,
                x: 320,
                y: 180,
              },
              {
                key: "output-task-2",
                resultKey: "task-2#0",
                sourceNodeId: "gen-node-2",
                taskId: "task-2",
                mediaType: "video",
                finalPath: "C:\\generated\\night-train.mp4",
                name: "night-train.mp4",
                aspectRatio: 16 / 9,
                x: 880,
                y: 180,
              },
            ],
            assetEdges: [],
            view: { zoom: 1, pan: { x: 0, y: 0 } },
            prompts: {},
          },
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      return baseInvokeImplementation(command);
    });
    render(<App />);

    const card = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--image");
      expect(node).not.toBeNull();
      return node!;
    });
    fireEvent.click(within(card).getByRole("button", { name: "全屏浏览产物：night-train.png" }));

    const lightbox = screen.getByRole("dialog", { name: "媒体预览" });
    expect(lightbox).toBeInTheDocument();
    expect(within(lightbox).getByRole("img", { name: "night-train.png" })).toHaveAttribute(
      "src",
      expect.stringContaining("night-train.png"),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "媒体预览" })).not.toBeInTheDocument();

    const videoCard = document.querySelector<HTMLElement>(".canvas-asset-node--output--video");
    expect(videoCard).not.toBeNull();
    fireEvent.click(
      within(videoCard!).getByRole("button", { name: "全屏浏览产物：night-train.mp4" }),
    );
    const videoLightbox = screen.getByRole("dialog", { name: "媒体预览" });
    expect(within(videoLightbox).getByLabelText("night-train.mp4")).toHaveAttribute(
      "src",
      expect.stringContaining("night-train.mp4"),
    );
    expect(within(videoLightbox).getByLabelText("night-train.mp4")).toHaveAttribute("controls");
  });

  /** 恢复一张已落卡（含产物文件）的图片产物卡片。 */
  function restoreCompletedImageOutputCard(): void {
    invokeMock.mockImplementation((command) => {
      if (command === "get_canvas_document") {
        return Promise.resolve({
          id: "canvas-scene-03",
          title: "未命名画布",
          document: {
            version: 1,
            assetNodes: [],
            genNodes: [],
            resultNodes: [],
            outputNodes: [
              {
                key: "output-task-1",
                resultKey: "task-1#0",
                sourceNodeId: "gen-node-1",
                taskId: "task-1",
                mediaType: "image",
                finalPath: "C:\\generated\\night-train.png",
                name: "night-train.png",
                aspectRatio: 16 / 9,
                x: 320,
                y: 180,
              },
            ],
            assetEdges: [],
            // zoom 状态存的是百分比：100 表示不缩放，board 坐标与 client 坐标一致。
            view: { zoom: 100, pan: { x: 0, y: 0 } },
            prompts: {},
          },
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      return baseInvokeImplementation(command);
    });
  }

  it("已落卡的产物节点可通过拖拽把手自由移动，位移足够时不触发全屏预览", async () => {
    restoreCompletedImageOutputCard();
    render(<App />);

    const card = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--image");
      expect(node).not.toBeNull();
      return node!;
    });
    // 通过拖拽把手移动产物节点（画布坐标位移 +59/+33）。
    const { before, after } = dragNodeViaHandle(card, ".canvas-asset-node__identity", 59, 33);
    expect(after.x).toBeCloseTo(before.x + 59, 1);
    expect(after.y).toBeCloseTo(before.y + 33, 1);
    // 位移明显的手势是拖动，不应打开全屏预览。
    expect(screen.queryByRole("dialog", { name: "媒体预览" })).not.toBeInTheDocument();
  });

  it("产物节点媒体上的点按（未拖动）抬起时仍打开全屏预览", async () => {
    restoreCompletedImageOutputCard();
    render(<App />);

    const card = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--image");
      expect(node).not.toBeNull();
      return node!;
    });
    const mediaButton = within(card).getByRole("button", { name: "全屏浏览产物：night-train.png" });
    // 媒体按钮未发生位移时按点击处理，直接打开全屏预览。
    fireEvent.click(mediaButton);

    expect(screen.getByRole("dialog", { name: "媒体预览" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "媒体预览" })).not.toBeInTheDocument();

    // 键盘 Enter 路径保留：聚焦按钮直接激活。
    fireEvent.click(mediaButton);
    expect(screen.getByRole("dialog", { name: "媒体预览" })).toBeInTheDocument();
  });

  it.each(["queued", "running"] as const)(
    "%s 状态的占位产物卡片不被生成状态禁用拖动",
    async (taskStatus) => {
      // 任务列表始终返回目标状态任务，占位卡片处于进行中阶段。
      invokeMock.mockImplementation((command) => {
        if (command === "list_generation_tasks") {
          const task = makeTaskSummary({
            status: taskStatus,
            progress: taskStatus === "running" ? 46 : null,
          });
          return Promise.resolve({ items: [task], nextCursorCreatedBefore: null });
        }
        if (command === "get_canvas_document") {
          return Promise.resolve({
            id: "canvas-scene-03",
            title: "未命名画布",
            document: {
              version: 1,
              assetNodes: [],
              genNodes: [],
              resultNodes: [],
              outputNodes: [
                {
                  key: "output-task-1",
                  resultKey: null,
                  sourceNodeId: "gen-node-1",
                  taskId: "task-1",
                  mediaType: "video",
                  finalPath: null,
                  name: null,
                  x: 320,
                  y: 180,
                },
              ],
              assetEdges: [
                { id: "gen-node-1->output-task-1", fromKey: "gen-node-1", toKey: "output-task-1" },
              ],
              view: { zoom: 100, pan: { x: 0, y: 0 } },
              prompts: {},
            },
            revision: 1,
            createdAt: 0,
            updatedAt: 0,
          });
        }
        return baseInvokeImplementation(command);
      });
      render(<App />);

      const card = await waitFor(() => {
        const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--video");
        expect(node).not.toBeNull();
        return node!;
      });
      await screen.findByText(taskStatus === "running" ? /生成中 · 46%/ : "排队中");
      expect(card).toHaveAttribute("aria-busy", "true");

      // 通过拖拽把手拖动：生成过程中位置照常更新。
      const { before, after } = dragNodeViaHandle(card, ".canvas-asset-node__identity", -50, -60);
      expect(after.x).toBeCloseTo(before.x - 50, 1);
      expect(after.y).toBeCloseTo(before.y - 60, 1);
    },
  );

  it("结果返回后先显示临时预览，保存完成后切换到本地文件", async () => {
    const succeededTask = makeTaskSummary({
      operation: "text_to_image",
      status: "succeeded",
      remoteTaskId: null,
      progress: 100,
      completedAt: 1,
    });
    invokeMock.mockImplementation((command) => {
      if (command === "list_generation_tasks") {
        return Promise.resolve({ items: [succeededTask], nextCursorCreatedBefore: null });
      }
      if (command === "get_canvas_document") {
        return Promise.resolve({
          id: "canvas-scene-03",
          title: "未命名画布",
          document: {
            version: 1,
            assetNodes: [],
            genNodes: [],
            resultNodes: [],
            outputNodes: [
              {
                key: "output-task-1",
                resultKey: null,
                sourceNodeId: succeededTask.sourceNodeId,
                taskId: succeededTask.id,
                mediaType: "image",
                finalPath: null,
                name: null,
                x: 320,
                y: 180,
              },
            ],
            assetEdges: [],
            view: { zoom: 100, pan: { x: 0, y: 0 } },
            prompts: {},
          },
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      return baseInvokeImplementation(command);
    });
    render(<App />);

    const card = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--image");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(card).not.toHaveClass("canvas-asset-node--media");

    const readyRecord = {
      taskId: succeededTask.id,
      resultIndex: 1,
      mediaType: "image",
      remoteTaskId: null,
      source: { kind: "url", url: "https://cdn.example.com/generated.png" },
      saveStatus: "writing",
      finalPath: null,
      relativePath: null,
      byteSize: null,
      mimeType: null,
      sha256: null,
      savedAt: null,
      error: null,
    };
    const readyListener = await waitFor(() => {
      const call = invokeMock.mock.calls.find(
        ([command, args]) =>
          command === "plugin:event|listen" && args?.["event"] === "generation:result-ready",
      );
      expect(call).toBeDefined();
      return call!;
    });
    const readyHandler = tauriCallbacks.get(readyListener[1]?.["handler"] as number);
    expect(readyHandler).toBeDefined();
    act(() => {
      readyHandler!({
        event: "generation:result-ready",
        id: 1,
        payload: {
          taskId: succeededTask.id,
          result: readyRecord,
          previewSrc: readyRecord.source.url,
        },
      });
    });

    const preview = await waitFor(() => {
      const image = card.querySelector<HTMLImageElement>("img");
      expect(image).not.toBeNull();
      return image!;
    });
    expect(preview).toHaveAttribute("src", "https://cdn.example.com/generated.png");
    expect(card).toHaveClass("canvas-asset-node--media");
    expect(within(card).getByText(/正在保存本地副本/)).toBeInTheDocument();

    const savedRecord = {
      ...readyRecord,
      saveStatus: "succeeded",
      finalPath: "C:\\generated\\generated.png",
      relativePath: "无限画布/generated.png",
      byteSize: 2048,
      mimeType: "image/png",
      sha256: "abc123",
      savedAt: 2,
    };
    const savedListener = await waitFor(() => {
      const call = invokeMock.mock.calls.find(
        ([command, args]) =>
          command === "plugin:event|listen" && args?.["event"] === "generation:result-saved",
      );
      expect(call).toBeDefined();
      return call!;
    });
    const savedHandler = tauriCallbacks.get(savedListener[1]?.["handler"] as number);
    expect(savedHandler).toBeDefined();
    act(() => {
      savedHandler!({
        event: "generation:result-saved",
        id: 2,
        payload: { taskId: succeededTask.id, result: savedRecord },
      });
    });

    await waitFor(() => {
      expect(card.querySelector("img")).toHaveAttribute(
        "src",
        expect.stringContaining("generated.png"),
      );
    });
    expect(within(card).getByText(/已连线来源节点/)).toBeInTheDocument();
  });

  it.each(["queued", "running"] as const)(
    "%s 状态的源节点保持可拖动，不禁用可拖动状态",
    async (taskStatus) => {
      // start_generation 挂起使节点先停在「提交中」；解析为目标状态任务后继续验证。
      let resolveStart!: (taskId: string) => void;
      const pendingStart = new Promise<string>((resolve) => {
        resolveStart = resolve;
      });
      let genNodeKey = "";
      invokeMock.mockImplementation((command) => {
        if (command === "start_generation") return pendingStart;
        if (command === "list_generation_tasks") {
          if (!genNodeKey) return baseInvokeImplementation(command);
          const task = makeTaskSummary({
            id: "task-1",
            sourceNodeId: genNodeKey,
            status: taskStatus,
            progress: taskStatus === "running" ? 52 : null,
          });
          return Promise.resolve({ items: [task], nextCursorCreatedBefore: null });
        }
        return baseInvokeImplementation(command);
      });
      render(<App />);

      const videoGeneration = await addGenerationNode("视频", 555, 222);
      genNodeKey = videoGeneration.dataset["connectionTarget"] ?? "";
      await waitFor(() => {
        expect(within(videoGeneration).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
      });
      setPromptText(
        within(videoGeneration).getByRole("textbox", {
          name: "提示词输入框，输入 @ 引用素材",
        }),
        "夜色中的城市街景俯拍镜头",
      );
      fireEvent.click(within(videoGeneration).getByRole("button", { name: "开始视频生成" }));

      /** 通过拖拽把手拖动当前节点本体（画布坐标位移 +27/+19）。 */
      const dragBody = () => {
        const { before, after } = dragNodeViaHandle(
          videoGeneration,
          ".canvas-gen-node__header",
          27,
          19,
        );
        expect(after.x).toBeCloseTo(before.x + 27, 1);
        expect(after.y).toBeCloseTo(before.y + 19, 1);
      };

      // 提交中（按钮已禁用）：节点本体仍可拖动。
      await waitFor(() => {
        expect(
          within(videoGeneration).getByRole("button", { name: "开始视频生成" }),
        ).toBeDisabled();
      });
      expect(videoGeneration).toHaveAttribute("aria-busy", "true");
      dragBody();

      // 任务创建成功并同步为目标状态：排队中/生成中依旧可拖动。
      resolveStart("task-1");
      await within(videoGeneration).findByText(taskStatus === "running" ? "生成中" : "排队中");
      expect(videoGeneration).toHaveAttribute("aria-busy", "true");
      dragBody();
    },
  );

  it("任务记录同步前占位卡片不误报失败", async () => {
    // 任务列表始终为空（极端情况：任务记录尚未可查）：卡片应保持进行中等待态，
    // 而不是闪现「任务记录不存在」的失败态。
    render(<App />);

    const videoGeneration = await addGenerationNode("视频", 555, 222);
    await waitFor(() => {
      expect(within(videoGeneration).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });
    setPromptText(
      within(videoGeneration).getByRole("textbox", {
        name: "提示词输入框，输入 @ 引用素材",
      }),
      "夜色中的城市街景俯拍镜头",
    );
    fireEvent.click(within(videoGeneration).getByRole("button", { name: "开始视频生成" }));

    await waitFor(() => {
      expect(document.querySelector(".canvas-asset-node--output")).not.toBeNull();
    });
    const card = document.querySelector<HTMLElement>(".canvas-asset-node--output")!;
    expect(card).not.toHaveClass("canvas-asset-node--output--failed");
    expect(screen.getByText("任务记录同步中")).toBeInTheDocument();
    expect(screen.queryByLabelText("完整原始返回")).not.toBeInTheDocument();
  });

  it("失败任务的产物卡片展示完整原始返回", async () => {
    const failedTask = makeTaskSummary({ status: "failed", progress: null, completedAt: 1000 });
    const failedDetail: GenerationTaskDetail = {
      summary: failedTask,
      logicalRequest: null,
      resolvedRequest: null,
      attempts: [],
      calls: [
        {
          id: "call-1",
          taskId: failedTask.id,
          attemptId: "attempt-1",
          phase: "query",
          request: null,
          sentAt: 0,
          responseReceivedAt: 1000,
          durationMs: 1000,
          httpStatus: 503,
          responseHeaders: null,
          rawResponse:
            '{"code":"UPSTREAM_OVERLOADED","message":"上游服务过载，请稍后重试","request_id":"req_91ad"}',
          runtimeError: null,
        },
      ],
      events: [],
      results: [],
      textOutput: null,
      finalError: null,
    };
    invokeMock.mockImplementation((command) => {
      if (command === "list_generation_tasks") {
        return Promise.resolve({ items: [failedTask], nextCursorCreatedBefore: null });
      }
      if (command === "get_generation_task") {
        return Promise.resolve(failedDetail);
      }
      return baseInvokeImplementation(command);
    });
    render(<App />);

    const videoGeneration = await addGenerationNode("视频", 555, 222);
    await waitFor(() => {
      expect(within(videoGeneration).getByLabelText("供应商")).toHaveValue(PROVIDER.id);
    });
    setPromptText(
      within(videoGeneration).getByRole("textbox", {
        name: "提示词输入框，输入 @ 引用素材",
      }),
      "夜色中的城市街景俯拍镜头",
    );
    fireEvent.click(within(videoGeneration).getByRole("button", { name: "开始视频生成" }));

    // 失败态卡片自动拉取任务详情，完整原始错误不截断直接展示。
    const card = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--failed");
      expect(node).not.toBeNull();
      return node!;
    });
    await waitFor(() => {
      expect(within(card).getByLabelText("完整原始返回")).toHaveTextContent(
        '"code":"UPSTREAM_OVERLOADED"',
      );
    });
    const rawError = within(card).getByLabelText("完整原始返回");
    expect(rawError).toHaveTextContent("HTTP 503");
    expect(rawError).toHaveTextContent("req_91ad");
    expect(within(card).getByText("失败")).toBeInTheDocument();
    // 旧的展开/收起交互已移除：原始返回常驻卡片，无需点击即可见。
    expect(within(card).queryByRole("button", { name: "查看原始返回" })).not.toBeInTheDocument();

    // 一键复制：等待原始返回加载完成（按钮解除禁用）后点击，
    // 完整错误写入系统剪贴板（含 HTTP 状态行与原始响应体），并短暂反馈「已复制」。
    const copyButton = within(card).getByRole("button", { name: "复制错误信息" });
    await waitFor(() => expect(copyButton).toBeEnabled());
    fireEvent.click(copyButton);
    const copiedText = await waitFor(() => {
      const clipboardCalls = invokeMock.mock.calls.filter(
        ([command]) => command === "plugin:clipboard-manager|write_text",
      );
      expect(clipboardCalls).toHaveLength(1);
      const text = (clipboardCalls[0]![1] as { text: string }).text;
      expect(text).toContain("HTTP 503");
      return text;
    });
    expect(copiedText).toContain('"code":"UPSTREAM_OVERLOADED"');
    expect(within(card).getByRole("button", { name: "复制错误信息" })).toHaveTextContent("已复制");
  });

  it("同一个素材可重复拖入画布", async () => {
    render(<App />);

    const first = await addAssetNode("图片", "站台参考图", 148, 148);
    const second = await addAssetNode("图片", "站台参考图", 148, 333);

    expect(first).not.toBe(second);
    expect(document.querySelectorAll(".canvas-asset-node")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "从 站台参考图 拖出连线" })).toHaveLength(2);
  });

  it("图片素材节点按原图比例自适应卡片尺寸，完整展示且不裁切", async () => {
    render(<App />);
    const node = await addAssetNode("图片", "站台参考图", 148, 148);
    const image = node.querySelector<HTMLImageElement>("img");
    expect(image).not.toBeNull();

    Object.defineProperties(image!, {
      naturalWidth: { value: 1600, configurable: true },
      naturalHeight: { value: 900, configurable: true },
    });
    fireEvent.load(image!);

    await waitFor(() => {
      expect(node).toHaveStyle({ width: "500px" });
      expect(parseFloat(node.style.height)).toBeCloseTo(281.25, 2);
    });

    Object.defineProperties(image!, {
      naturalWidth: { value: 900, configurable: true },
      naturalHeight: { value: 1600, configurable: true },
    });
    fireEvent.load(image!);

    await waitFor(() => {
      expect(parseFloat(node.style.width)).toBeCloseTo(246.09, 2);
      expect(node).toHaveStyle({ height: "437.5px" });
    });
  });

  it("素材库图片卡片按原图比例设置视觉区，瀑布流中不裁切", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /^图片( \d+)?$/ }));
    const card = await screen.findByRole("button", {
      name: "预览图片素材详情：站台参考图",
    });
    const visual = card.querySelector<HTMLElement>(".asset-card__visual");
    const image = card.querySelector<HTMLImageElement>(".asset-card__preview");
    expect(visual).not.toBeNull();
    expect(image).not.toBeNull();
    expect(visual!).toHaveStyle({ aspectRatio: "" });

    Object.defineProperties(image!, {
      naturalWidth: { value: 1600, configurable: true },
      naturalHeight: { value: 900, configurable: true },
    });
    fireEvent.load(image!);

    await waitFor(() => {
      // jsdom 会把 aspect-ratio 规范化为 "1.7778 / 1"，这里只比较数值。
      expect(parseFloat(visual!.style.aspectRatio)).toBeCloseTo(1.7778, 3);
    });
  });

  it("素材拖入后的浏览器 click 不会重复创建节点", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /^图片( \d+)?$/ }));
    const card = await screen.findByRole("button", {
      name: "预览图片素材详情：站台参考图",
    });

    dragToCanvas(card, 148, 148);
    fireEvent.click(card);

    await waitFor(() => {
      expect(document.querySelectorAll(".canvas-asset-node")).toHaveLength(1);
    });
  });

  it("视频素材卡片展示关键帧，悬浮播放并在移开后复位", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /^视频( \d+)?$/ }));
    const card = await screen.findByRole("button", {
      name: "预览视频素材详情：列车进站参考",
    });
    const visual = card.querySelector<HTMLElement>(".asset-card__visual--video");
    const cover = card.querySelector<HTMLImageElement>(".asset-card__preview");
    const video = card.querySelector<HTMLVideoElement>("video");

    expect(visual).not.toBeNull();
    expect(cover).toHaveAttribute(
      "src",
      `asset://localhost/video?src=${encodeURIComponent("https://cdn.example.com/train-keyframe.jpg")}`,
    );
    expect(video).toHaveAttribute(
      "src",
      `asset://localhost/video?src=${encodeURIComponent("https://cdn.example.com/train.mp4")}`,
    );
    expect(video).toHaveAttribute(
      "poster",
      `asset://localhost/video?src=${encodeURIComponent("https://cdn.example.com/train-keyframe.jpg")}`,
    );
    fireEvent.loadedData(video!);
    expect(video).toHaveClass("is-ready");

    fireEvent.mouseEnter(card);
    expect(mediaPlayMock).toHaveBeenCalledTimes(1);
    expect(visual).toHaveClass("is-playing");
    video!.currentTime = 3;
    fireEvent.mouseLeave(card);
    expect(mediaPauseMock).toHaveBeenCalledTimes(1);
    expect(video!.currentTime).toBe(0);
    expect(visual).not.toHaveClass("is-playing");
  });

  it("素材库视频卡片按视频比例设置视觉区，瀑布流中不裁切", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /^视频( \d+)?$/ }));
    const card = await screen.findByRole("button", {
      name: "预览视频素材详情：列车进站参考",
    });
    const visual = card.querySelector<HTMLElement>(".asset-card__visual--video");
    const video = card.querySelector<HTMLVideoElement>("video");
    expect(visual).not.toBeNull();
    expect(video).not.toBeNull();
    expect(visual!).toHaveStyle({ aspectRatio: "" });

    Object.defineProperties(video!, {
      videoWidth: { value: 1080, configurable: true },
      videoHeight: { value: 1920, configurable: true },
    });
    fireEvent.loadedMetadata(video!);

    await waitFor(() => {
      expect(parseFloat(visual!.style.aspectRatio)).toBeCloseTo(0.5625, 3);
    });
  });

  it("无供应商封面时素材卡片抽取视频中间帧作静止封面", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /^视频( \d+)?$/ }));
    const card = await screen.findByRole("button", {
      name: "预览视频素材详情：衣摆运动参考",
    });
    const video = card.querySelector<HTMLVideoElement>("video");

    // 封面就绪前只显示中性加载状态。
    expect(video).toHaveAttribute(
      "src",
      `asset://localhost/video?src=${encodeURIComponent("https://cdn.example.com/hem.mp4")}`,
    );
    expect(video).not.toHaveAttribute("poster");
    expect(within(card).getByText("正在加载预览")).toBeInTheDocument();

    // 元数据就绪后 seek 到中点，中间帧替换占位图。
    Object.defineProperty(video!, "duration", { value: 10, configurable: true });
    fireEvent.loadedMetadata(video!);
    expect(video!.currentTime).toBe(5);
    fireEvent.loadedData(video!);
    expect(video).toHaveClass("is-cover");
    expect(within(card).queryByText("正在加载预览")).not.toBeInTheDocument();

    // 悬浮自动播放，移开暂停并回到中间帧。
    fireEvent.mouseEnter(card);
    expect(mediaPlayMock).toHaveBeenCalledTimes(1);
    video!.currentTime = 8;
    fireEvent.mouseLeave(card);
    expect(mediaPauseMock).toHaveBeenCalledTimes(1);
    expect(video!.currentTime).toBe(5);
  });

  it("视频素材节点在画布上抽取中间帧作封面并悬浮播放", async () => {
    render(<App />);
    const node = await addAssetNode("视频", "列车进站参考", 148, 148);

    const video = node.querySelector<HTMLVideoElement>("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute(
      "src",
      `asset://localhost/video?src=${encodeURIComponent("https://cdn.example.com/train.mp4")}`,
    );
    expect(video).toHaveAttribute("preload", "metadata");
    expect(within(node).getByText("正在加载预览")).toBeInTheDocument();

    // 元数据就绪后 seek 到中点，中间帧作为静止封面。
    Object.defineProperties(video!, {
      duration: { value: 8, configurable: true },
      videoWidth: { value: 1920, configurable: true },
      videoHeight: { value: 1080, configurable: true },
    });
    fireEvent.loadedMetadata(video!);
    expect(video!.currentTime).toBe(4);
    fireEvent.loadedData(video!);
    expect(within(node).queryByText("正在加载预览")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(node).toHaveStyle({ width: "500px" });
      expect(parseFloat(node.style.height)).toBeCloseTo(281.25, 2);
    });

    // 悬浮自动播放，移开暂停并回到中间帧封面。
    fireEvent.mouseEnter(node);
    expect(mediaPlayMock).toHaveBeenCalledTimes(1);
    video!.currentTime = 6;
    fireEvent.mouseLeave(node);
    expect(mediaPauseMock).toHaveBeenCalledTimes(1);
    expect(video!.currentTime).toBe(4);
  });

  it("画布中的云端图片和视频加载失败时显示真实错误状态而不是演示图", async () => {
    render(<App />);
    const imageNode = await addAssetNode("图片", "站台参考图", 148, 148);
    const image = imageNode.querySelector<HTMLImageElement>("img");
    expect(image).not.toBeNull();
    fireEvent.error(image!);
    expect(within(imageNode).getByText("预览不可用")).toBeInTheDocument();

    const videoNode = await addAssetNode("视频", "列车进站参考", 700, 148);
    const video = videoNode.querySelector<HTMLVideoElement>("video");
    expect(video).not.toBeNull();
    fireEvent.error(video!);
    expect(within(videoNode).getByText("预览不可用")).toBeInTheDocument();
  });

  it("从素材节点连到拖入的图片生成节点时携带 explicitMedia 并切换图生图", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 444, 148);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 222);

    connectAssetToGeneration(assetNode, imageGeneration);
    expect(
      await within(imageGeneration).findByRole("button", { name: "解除连线：站台参考图" }),
    ).toBeInTheDocument();
    expect(document.querySelector(".edge--asset-generation")).not.toBeNull();
    expect(within(imageGeneration).getByText("图片参考生成")).toBeInTheDocument();
    // GPT Image 契约：图生图（图片编辑）接口同样声明尺寸/质量参数。
    expect(within(imageGeneration).getByLabelText("尺寸")).toBeInTheDocument();
    expect(within(imageGeneration).getByLabelText("质量")).toBeInTheDocument();

    const promptInput = within(imageGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    setPromptText(promptInput, "生成雨夜站台关键帧");
    fireEvent.click(within(imageGeneration).getByRole("button", { name: "开始图片生成" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_generation", expect.anything());
    });
    const command = submittedGenerationCommand();
    expect(command["operation"]).toBe("image_to_image");
    expect(command["parameters"]).toEqual({ size: "auto", quality: "auto", n: 1 });
    expect(command["explicitMedia"]).toEqual([
      {
        target: {
          kind: "asset",
          providerConnectionId: "moyu-production",
          assetId: "asset-image-1",
          canvasNodeKey: assetNode.dataset["connectionTarget"],
          mediaType: "image",
        },
        role: "",
        displayNameSnapshot: "站台参考图",
        typePosition: 1,
        contentIndex: 1,
      },
    ]);
  });

  it("已保存的图片产物可连入下一图片节点，并作为 local_result 参考输入提交", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "get_canvas_document") {
        return Promise.resolve({
          id: "canvas-scene-03",
          title: "未命名画布",
          document: {
            version: 1,
            assetNodes: [],
            genNodes: [],
            resultNodes: [],
            outputNodes: [
              {
                key: "output-upstream-image",
                resultKey: "upstream-image-task#2",
                sourceNodeId: "upstream-image-node",
                taskId: "upstream-image-task",
                mediaType: "image",
                finalPath: "C:\\generated\\upstream-frame.png",
                name: "upstream-frame.png",
                aspectRatio: 16 / 9,
                x: 40,
                y: 180,
              },
            ],
            assetEdges: [],
            view: { zoom: 74, pan: { x: 0, y: 0 } },
            prompts: {},
          },
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      return baseInvokeImplementation(command);
    });
    render(<App />);

    const output = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--image");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(
      within(output).getByRole("button", {
        name: "从图片产物 upstream-frame.png 拖出连线",
      }),
    ).toBeInTheDocument();
    const imageGeneration = await addGenerationNode("图片", 740, 240);
    connectAssetToGeneration(output, imageGeneration);

    expect(
      await within(imageGeneration).findByRole("button", {
        name: "解除连线：upstream-frame.png",
      }),
    ).toBeInTheDocument();
    expect(within(imageGeneration).getByText("产物")).toBeInTheDocument();
    expect(within(imageGeneration).getByText("图片参考生成")).toBeInTheDocument();

    setPromptText(
      within(imageGeneration).getByRole("textbox", {
        name: "提示词输入框，输入 @ 引用素材",
      }),
      "延续上游画面的色彩与构图",
    );
    fireEvent.click(within(imageGeneration).getByRole("button", { name: "开始图片生成" }));

    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    const command = submittedGenerationCommand();
    expect(command["operation"]).toBe("image_to_image");
    expect(command["explicitMedia"]).toEqual([
      {
        target: {
          kind: "local_result",
          generationTaskId: "upstream-image-task",
          resultIndex: 2,
          canvasNodeKey: "output-upstream-image",
          mediaType: "image",
        },
        role: "",
        displayNameSnapshot: "upstream-frame.png",
        typePosition: 1,
        contentIndex: 1,
      },
    ]);
  });

  it("已保存的视频产物可连入下一视频节点，并通过 @ 提交精确产物引用", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "get_canvas_document") {
        return Promise.resolve({
          id: "canvas-scene-03",
          title: "未命名画布",
          document: {
            version: 1,
            assetNodes: [],
            genNodes: [],
            resultNodes: [],
            outputNodes: [
              {
                key: "output-upstream-video",
                resultKey: "upstream-video-task#3",
                sourceNodeId: "upstream-video-node",
                taskId: "upstream-video-task",
                mediaType: "video",
                finalPath: "C:\\generated\\upstream-motion.mp4",
                name: "upstream-motion.mp4",
                aspectRatio: 16 / 9,
                x: 40,
                y: 180,
              },
            ],
            assetEdges: [],
            view: { zoom: 74, pan: { x: 0, y: 0 } },
            prompts: {},
          },
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      return baseInvokeImplementation(command);
    });
    render(<App />);

    const output = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".canvas-asset-node--output--video");
      expect(node).not.toBeNull();
      return node!;
    });
    const videoGeneration = await addGenerationNode("视频", 740, 240);
    connectAssetToGeneration(output, videoGeneration);
    expect(
      await within(videoGeneration).findByRole("button", {
        name: "解除连线：upstream-motion.mp4",
      }),
    ).toBeInTheDocument();

    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    setPromptText(promptInput, "承接 ");
    await insertMention(videoGeneration, "upstream-motion.mp4");
    appendPromptText(promptInput, " 的最后一个镜头继续向前运动");
    fireEvent.click(within(videoGeneration).getByRole("button", { name: "开始视频生成" }));

    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    const command = submittedGenerationCommand();
    expect(command["explicitMedia"]).toMatchObject([
      {
        target: {
          kind: "local_result",
          generationTaskId: "upstream-video-task",
          resultIndex: 3,
          canvasNodeKey: "output-upstream-video",
          mediaType: "video",
        },
        typePosition: 1,
        contentIndex: 1,
      },
    ]);
    const prompt = command["prompt"] as readonly { kind: string; mentionId?: string }[];
    const mentionId = prompt.find((segment) => segment.kind === "media_reference")?.mentionId;
    expect(mentionId).toMatch(/^mention-/);
    expect(prompt).toEqual([
      { kind: "text", text: "承接 " },
      {
        kind: "media_reference",
        mentionId,
        target: {
          kind: "local_result",
          generationTaskId: "upstream-video-task",
          resultIndex: 3,
          canvasNodeKey: "output-upstream-video",
          mediaType: "video",
        },
        displayNameSnapshot: "upstream-motion.mp4",
        typePosition: 1,
        contentIndex: 1,
      },
      { kind: "text", text: " 的最后一个镜头继续向前运动" },
    ]);
  });

  it("解除连线后生成退回文生图且不带显式媒体输入", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 444, 148);
    fireEvent.change(within(imageGeneration).getByLabelText("尺寸"), {
      target: { value: "1536x1024" },
    });
    fireEvent.change(within(imageGeneration).getByLabelText("质量"), {
      target: { value: "high" },
    });
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 222);
    connectAssetToGeneration(assetNode, imageGeneration);
    // GPT Image 契约：图生图（图片编辑）接口同样声明尺寸/质量参数，且沿用已选值。
    expect(within(imageGeneration).getByLabelText("尺寸")).toHaveValue("1536x1024");
    expect(within(imageGeneration).getByLabelText("质量")).toHaveValue("high");

    const unlink = await within(imageGeneration).findByRole("button", {
      name: "解除连线：站台参考图",
    });
    fireEvent.click(unlink);
    expect(screen.queryByRole("button", { name: "解除连线：站台参考图" })).not.toBeInTheDocument();
    expect(document.querySelector(".edge--asset-generation")).toBeNull();
    expect(within(imageGeneration).getByLabelText("尺寸")).toHaveValue("1536x1024");
    expect(within(imageGeneration).getByLabelText("质量")).toHaveValue("high");

    setPromptText(
      within(imageGeneration).getByRole("textbox", {
        name: "提示词输入框，输入 @ 引用素材",
      }),
      "纯文本生成站台",
    );
    fireEvent.click(within(imageGeneration).getByRole("button", { name: "开始图片生成" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_generation", expect.anything());
    });
    const command = submittedGenerationCommand();
    expect(command["operation"]).toBe("text_to_image");
    expect(command["explicitMedia"]).toEqual([]);
    expect(command["parameters"]).toEqual({
      size: "1536x1024",
      quality: "high",
      n: 1,
      response_format: "b64_json",
    });
  });

  it("断线后的 @ 实例不能继续提交", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    await insertMention(videoGeneration, "站台参考图");

    fireEvent.click(within(videoGeneration).getByRole("button", { name: "解除连线：站台参考图" }));
    fireEvent.click(within(videoGeneration).getByRole("button", { name: "开始视频生成" }));

    expect(await screen.findByLabelText("发起任务失败")).toHaveTextContent(
      "@站台参考图 已与当前节点断开",
    );
    expect(invokeMock.mock.calls.some(([command]) => command === "start_generation")).toBe(false);
  });

  it("移除素材节点会同时清除其连线", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 444, 148);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 222);
    connectAssetToGeneration(assetNode, imageGeneration);
    expect(
      await within(imageGeneration).findByRole("button", { name: "解除连线：站台参考图" }),
    ).toBeInTheDocument();

    fireEvent.click(within(assetNode).getByRole("button", { name: "移除素材节点：站台参考图" }));
    expect(screen.queryByRole("button", { name: "解除连线：站台参考图" })).not.toBeInTheDocument();
    expect(document.querySelector(".edge--asset")).toBeNull();
    expect(document.querySelector(".canvas-asset-node")).toBeNull();
  });

  it("素材节点可自由拖动位置，连线端点跟随更新", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 666, 148);
    // 投放素材节点：中心落在画布 (290, 378.75)，左上角 (40, 160)。
    const assetNode = await addAssetNode("图片", "站台参考图", 214.6, 280.275);
    connectAssetToGeneration(assetNode, imageGeneration);
    const edgeBefore = await waitFor(() => {
      const edge = document.querySelector(".edge--asset-generation");
      expect(edge).not.toBeNull();
      return edge!.getAttribute("d");
    });
    expect(edgeBefore).toBeTruthy();

    // 通过拖拽把手拖动节点（画布坐标位移 +50/+40）。
    const { before, after } = dragNodeViaHandle(assetNode, ".canvas-asset-node__identity", 50, 40);
    expect(after.x).toBeCloseTo(before.x + 50, 1);
    expect(after.y).toBeCloseTo(before.y + 40, 1);

    // 连线端点跟随节点移动。
    await waitFor(() => {
      const edgeAfter = document.querySelector(".edge--asset-generation")!.getAttribute("d");
      expect(edgeAfter).not.toBe(edgeBefore);
    });
  });

  it("拖动进行中会连续渲染节点位置，而不是只在松手后跳到终点", async () => {
    render(<App />);
    const assetNode = await addAssetNode("图片", "站台参考图", 214.6, 280.275);
    const handle = assetNode.querySelector<HTMLElement>(".canvas-asset-node__identity");
    expect(handle).not.toBeNull();
    const before = rfNodeFlowPosition(assetNode);

    fireCanvasMouse(handle!, "mousedown", clientFromFlow(before.x, before.y));
    fireCanvasMouse(document, "mousemove", clientFromFlow(before.x + 2, before.y + 2));
    fireCanvasMouse(document, "mousemove", clientFromFlow(before.x + 32, before.y + 22));
    const duringFirstMove = rfNodeFlowPosition(assetNode);
    fireCanvasMouse(document, "mousemove", clientFromFlow(before.x + 62, before.y + 42));
    const duringSecondMove = rfNodeFlowPosition(assetNode);
    fireCanvasMouse(document, "mouseup", clientFromFlow(before.x + 62, before.y + 42));

    expect(duringFirstMove.x).toBeCloseTo(before.x + 30, 1);
    expect(duringFirstMove.y).toBeCloseTo(before.y + 20, 1);
    expect(duringSecondMove.x).toBeCloseTo(before.x + 60, 1);
    expect(duringSecondMove.y).toBeCloseTo(before.y + 40, 1);
  });

  it("未选中节点第一次按下即可连续拖动，不需要先点击显示选中框", async () => {
    render(<App />);
    const targetNode = await addAssetNode("图片", "站台参考图", 214.6, 280.275);
    const otherNode = await addGenerationNode("图片", 760, 220);
    expect(rfWrapperOf(targetNode)).not.toHaveClass("selected");
    expect(rfWrapperOf(otherNode)).toHaveClass("selected");

    const handle = targetNode.querySelector<HTMLElement>(".canvas-asset-node__identity");
    expect(handle).not.toBeNull();
    const before = rfNodeFlowPosition(targetNode);
    fireCanvasMouse(handle!, "mousedown", clientFromFlow(before.x, before.y));
    fireCanvasMouse(document, "mousemove", clientFromFlow(before.x + 2, before.y + 2));

    const renderedFrames: { x: number; y: number }[] = [];
    for (let frame = 1; frame <= 6; frame += 1) {
      fireCanvasMouse(
        document,
        "mousemove",
        clientFromFlow(before.x + frame * 10 + 2, before.y + frame * 6 + 2),
      );
      renderedFrames.push(rfNodeFlowPosition(targetNode));
    }
    fireCanvasMouse(document, "mouseup", clientFromFlow(before.x + 62, before.y + 38));

    renderedFrames.forEach((position, index) => {
      expect(position.x).toBeCloseTo(before.x + (index + 1) * 10, 1);
      expect(position.y).toBeCloseTo(before.y + (index + 1) * 6, 1);
    });
  });

  it("未选中节点从卡片空白主体按下也能直接拖动", async () => {
    render(<App />);
    const targetNode = await addGenerationNode("图片", 440, 220);
    const otherNode = await addGenerationNode("视频", 900, 220);
    expect(rfWrapperOf(targetNode)).not.toHaveClass("selected");
    expect(rfWrapperOf(otherNode)).toHaveClass("selected");

    const before = rfNodeFlowPosition(targetNode);
    fireCanvasMouse(targetNode, "mousedown", clientFromFlow(before.x + 10, before.y + 10));
    fireCanvasMouse(document, "mousemove", clientFromFlow(before.x + 12, before.y + 12));
    fireCanvasMouse(document, "mousemove", clientFromFlow(before.x + 52, before.y + 42));
    const duringMove = rfNodeFlowPosition(targetNode);
    fireCanvasMouse(document, "mouseup", clientFromFlow(before.x + 52, before.y + 42));

    expect(duringMove.x).toBeCloseTo(before.x + 40, 1);
    expect(duringMove.y).toBeCloseTo(before.y + 30, 1);
  });

  it("节点主体可拖动时，输入框手势仍只编辑内容而不移动节点", async () => {
    render(<App />);
    const node = await addGenerationNode("图片", 440, 220);
    const promptInput = within(node).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    const before = rfNodeFlowPosition(node);

    fireCanvasMouse(promptInput, "mousedown", clientFromFlow(before.x + 30, before.y + 90));
    fireCanvasMouse(document, "mousemove", clientFromFlow(before.x + 32, before.y + 92));
    fireCanvasMouse(document, "mousemove", clientFromFlow(before.x + 72, before.y + 122));
    fireCanvasMouse(document, "mouseup", clientFromFlow(before.x + 72, before.y + 122));

    expect(rfNodeFlowPosition(node)).toEqual(before);
  });

  it("节点可拖到负坐标，画布无限延展不受边界钳制", async () => {
    render(<App />);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 222);

    // 通过拖拽把手把节点拖到视口左上角之外：画布无限延展，不回弹到 0。
    const { after } = dragNodeViaHandle(assetNode, ".canvas-asset-node__identity", -400, -450);
    expect(after.x).toBeLessThan(0);
    expect(after.y).toBeLessThan(0);
  });

  it("滚轮以鼠标位置为锚点缩放画布", async () => {
    render(<App />);

    // 等待桌面恢复与首次布局完成；过早派发 wheel 时 d3 已能缩放，
    // 但 React Flow 的 onMoveEnd 尚未订阅，缩放标签无法收到该次手势结果。
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:event|listen",
        expect.objectContaining({ event: "tauri://close-requested" }),
      ),
    );

    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    expect(pane).not.toBeNull();
    // d3-zoom 的 wheel 处理不依赖 event.view，可直接用 fireEvent。
    fireEvent.wheel(pane!, { deltaY: -100, clientX: 300, clientY: 200 });

    // RF 的 wheel 缩放：2^(100×0.002) ≈ 1.1487，默认 100% → 115%，并锚定鼠标位置平移。
    await waitFor(() => {
      expect(screen.getByText("115%")).toBeInTheDocument();
    });
    const viewportLayer = document.querySelector<HTMLElement>(".react-flow__viewport")!;
    expect(viewportLayer.style.transform).toContain("scale(1.14");
  });

  it("键入 @ 后点击候选会替换触发词，不留下重复 @", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "开场 ");
    fireEvent.keyDown(promptInput, { key: "@" });
    const instanceQuery = assetNode.dataset["connectionTarget"]!.slice(-6);
    appendPromptText(promptInput, "@");

    const menu = await screen.findByRole("listbox", { name: "素材引用候选" });
    appendPromptText(promptInput, instanceQuery);
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));
    fireEvent.compositionStart(promptInput);
    fireEvent.keyDown(promptInput, { key: "Enter", isComposing: true });
    expect(promptInput.querySelector(".mention-chip")).toBeNull();
    fireEvent.compositionEnd(promptInput);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    fireEvent.click(within(menu).getByRole("option", { name: /站台参考图/ }));

    expect(promptInput.textContent?.replaceAll("\u200b", "")).toBe("开场 @站台参考图 · 图片1");
    expect(promptInput.querySelectorAll(".mention-chip")).toHaveLength(1);
  });

  it("多素材连到视频节点后统一冻结连线编号，@ 引用与媒体清单一一对应", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const imageAsset = await addAssetNode("图片", "站台参考图", 148, 148);
    const videoAsset = await addAssetNode("视频", "列车进站参考", 148, 333);
    const imageNodeKey = imageAsset.dataset["connectionTarget"];
    const videoNodeKey = videoAsset.dataset["connectionTarget"];

    connectAssetToGeneration(imageAsset, videoGeneration);
    connectAssetToGeneration(videoAsset, videoGeneration);
    expect(
      await within(videoGeneration).findByRole("button", { name: "解除连线：站台参考图" }),
    ).toBeInTheDocument();
    expect(
      within(videoGeneration).getByRole("button", { name: "解除连线：列车进站参考" }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".edge--asset-generation")).toHaveLength(2);
    const connectedInputList = within(videoGeneration).getByRole("list", {
      name: "生成参考素材，按传入顺序排列",
    });
    expect(
      within(connectedInputList)
        .getAllByRole("listitem")
        .map((item) => ({
          order: item.querySelector(".node-media-chip__order")?.textContent,
          name: item.querySelector(".node-media-chip__name")?.textContent,
        })),
    ).toEqual([
      { order: "1", name: "站台参考图" },
      { order: "2", name: "列车进站参考" },
    ]);

    // 参考视频素材取中间帧作芯片缩略图：视频本体不再当作 <img> 加载。
    const videoChip = within(connectedInputList)
      .getAllByRole("listitem")
      .find(
        (item) => item.querySelector(".node-media-chip__name")?.textContent === "列车进站参考",
      )!;
    const videoThumb = videoChip.querySelector<HTMLVideoElement>(".auto-size-thumb video")!;
    const videoThumbBox = videoChip.querySelector<HTMLElement>(".auto-size-thumb")!;
    expect(videoChip.querySelector(".auto-size-thumb img")).toBeNull();
    expect(videoThumb).toHaveAttribute(
      "src",
      expect.stringContaining(encodeURIComponent("https://cdn.example.com/train.mp4")),
    );
    Object.defineProperties(videoThumb, {
      duration: { value: 8, configurable: true },
      videoWidth: { value: 1920, configurable: true },
      videoHeight: { value: 1080, configurable: true },
    });
    fireEvent.loadedMetadata(videoThumb);
    expect(videoThumb.currentTime).toBe(4);
    fireEvent.seeked(videoThumb);
    await waitFor(() => expect(videoThumb).toHaveClass("is-frame-ready"));
    // 高度固定 2.5rem，宽度按 16:9 自适应（2.5rem × 16/9 ≈ 4.444rem）。
    expect(parseFloat(videoThumbBox.style.aspectRatio)).toBeCloseTo(1920 / 1080, 3);
    expect(
      Array.from(document.querySelectorAll(".canvas-flow-edge__order")).map(
        (marker) => marker.textContent,
      ),
    ).toEqual(["1", "2"]);

    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    setPromptText(promptInput, "开场 ");
    await insertMention(videoGeneration, "站台参考图");
    appendPromptText(promptInput, "，随后 ");
    await insertMention(videoGeneration, "列车进站参考");
    appendPromptText(promptInput, "，镜头向右推进");

    fireEvent.click(within(videoGeneration).getByRole("button", { name: "开始视频生成" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_generation", expect.anything());
    });
    const command = submittedGenerationCommand();
    expect(command["operation"]).toBe("video_generation");
    expect(command["modelDefinitionId"]).toBe("doubao-seedance-2-5-260628");
    const prompt = command["prompt"] as readonly { kind: string; mentionId?: string }[];
    const mentionIds = prompt.flatMap((segment) =>
      segment.kind === "media_reference" && segment.mentionId ? [segment.mentionId] : [],
    );
    expect(mentionIds).toHaveLength(2);
    expect(mentionIds[0]).toMatch(/^mention-/);
    expect(mentionIds[1]).toMatch(/^mention-/);
    expect(new Set(mentionIds).size).toBe(2);
    expect(command["prompt"]).toEqual([
      { kind: "text", text: "开场 " },
      {
        kind: "media_reference",
        mentionId: mentionIds[0],
        target: {
          kind: "asset",
          providerConnectionId: "moyu-production",
          assetId: "asset-image-1",
          canvasNodeKey: imageNodeKey,
          mediaType: "image",
        },
        displayNameSnapshot: "站台参考图",
        typePosition: 1,
        contentIndex: 1,
      },
      { kind: "text", text: "，随后 " },
      {
        kind: "media_reference",
        mentionId: mentionIds[1],
        target: {
          kind: "asset",
          providerConnectionId: "moyu-production",
          assetId: "asset-video-1",
          canvasNodeKey: videoNodeKey,
          mediaType: "video",
        },
        displayNameSnapshot: "列车进站参考",
        typePosition: 1,
        contentIndex: 2,
      },
      { kind: "text", text: "，镜头向右推进" },
    ]);
    expect(command["explicitMedia"]).toMatchObject([
      { target: { canvasNodeKey: imageNodeKey }, typePosition: 1, contentIndex: 1 },
      { target: { canvasNodeKey: videoNodeKey }, typePosition: 1, contentIndex: 2 },
    ]);
  });

  it("粘贴含显式 @ 的提示词会被识别为高亮引用 chip，提交与手动选择等价", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, imageGeneration);
    const promptInput = within(imageGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    // 粘贴事件：clipboardData 提供 text/plain，默认行为被组件拦截改为纯文本插入。
    placeCaretAtEnd(promptInput);
    fireEvent.paste(promptInput, {
      clipboardData: { getData: () => "夜晚的@站台参考图缓缓进站" },
    });

    const chips = promptInput.querySelectorAll(".mention-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!).toHaveTextContent("@站台参考图");
    expect(chips[0]!).toHaveAttribute("data-auto", "true");
    expect(chips[0]!.className).toContain("is-fresh");
    expect(promptInput).toHaveTextContent(/缓缓进站/);
    expect(within(imageGeneration).getByRole("status", { name: /自动引用状态/ })).toHaveTextContent(
      "已自动引用 1 处素材",
    );

    fireEvent.click(within(imageGeneration).getByRole("button", { name: "开始图片生成" }));
    const command = submittedGenerationCommand();
    const segments = command["prompt"] as readonly {
      kind: string;
      text?: string;
      mentionId?: string;
      target?: Record<string, unknown>;
      displayNameSnapshot?: string;
    }[];
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: "text", text: "夜晚的" });
    expect(segments[1]).toMatchObject({
      kind: "media_reference",
      target: {
        kind: "asset",
        providerConnectionId: "moyu-production",
        assetId: "asset-image-1",
        canvasNodeKey: assetNode.dataset["connectionTarget"],
        mediaType: "image",
      },
      displayNameSnapshot: "站台参考图",
    });
    expect(segments[1]!.mentionId).toMatch(/^mention-/);
    expect(segments[2]).toMatchObject({ kind: "text", text: "缓缓进站" });
    expect(command["explicitMedia"]).toMatchObject([
      {
        target: { canvasNodeKey: assetNode.dataset["connectionTarget"] },
        typePosition: 1,
        contentIndex: 1,
      },
    ]);
  });

  it("输入和粘贴普通素材名保持正文，只有显式 @ 自动转换", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    setPromptText(promptInput, "站台参考图与图片1作为文字说明");
    await waitFor(() =>
      expect(within(videoGeneration).getByRole("status", { name: /自动引用状态/ })).toHaveAttribute(
        "data-state",
        "ready",
      ),
    );
    expect(promptInput.querySelector(".mention-chip")).toBeNull();
    placeCaretAtEnd(promptInput);
    fireEvent.paste(promptInput, {
      clipboardData: { getData: () => "，保留站台参考图，引用@图片1" },
    });
    expect(promptInput.querySelectorAll("[data-mention-id]")).toHaveLength(1);
    expect(promptInput).toHaveTextContent("站台参考图与图片1作为文字说明，保留站台参考图");
    fireEvent.click(within(videoGeneration).getByRole("button", { name: "开始视频生成" }));
    expect(submittedGenerationCommand()["prompt"]).toMatchObject([
      { kind: "text", text: "站台参考图与图片1作为文字说明，保留站台参考图，引用" },
      { kind: "media_reference", target: { canvasNodeKey: assetNode.dataset["connectionTarget"] } },
    ]);
  });

  it("提示词操作按钮保持独立并列，放大按钮不会遮挡立即识别", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 518, 222);
    const prompt = within(imageGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    const actions = prompt
      .closest<HTMLElement>(".prompt-mention__field")
      ?.querySelector<HTMLElement>(".prompt-mention__actions");
    expect(actions).not.toBeNull();
    expect(actions?.querySelector("button.prompt-mention__expand")).toBeInTheDocument();
    expect(actions?.querySelector("button.prompt-mention__trigger--detect")).toBeInTheDocument();
    expect(
      actions?.querySelector(
        "button.prompt-mention__trigger:not(.prompt-mention__trigger--detect)",
      ),
    ).toBeInTheDocument();
    expect([...actions!.querySelectorAll("button")].map((button) => button.className)).toEqual([
      "prompt-mention__expand",
      "prompt-mention__trigger prompt-mention__trigger--detect",
      "prompt-mention__trigger",
    ]);
  });

  it("点击「识别素材名」按钮先显示扫描中，再把普通名称转为引用 chip", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "回味一下站台参考图的氛围");
    expect(promptInput.querySelector(".mention-chip")).toBeNull();

    const detectButton = within(videoGeneration).getByRole("button", {
      name: "识别素材名",
    });
    fireEvent.click(detectButton);
    expect(detectButton).toHaveAttribute("data-result", "scanning");

    const chip = await waitFor(() => {
      const found = promptInput.querySelector(".mention-chip")!;
      expect(found).toHaveTextContent("@站台参考图");
      expect(detectButton).toHaveAttribute("data-result", "success");
      expect(
        within(videoGeneration).getByRole("status", { name: /自动引用状态/ }),
      ).toHaveTextContent("@站台参考图");
      return found;
    });
    expect(chip).toHaveAttribute("data-auto", "true");

    // 缩放和自动保存都会让父组件重渲染；素材集合未变时，成功反馈仍应按
    // 自己的展示时长保留，不能被内容相同的新数组引用提前重置。
    fireEvent.click(screen.getByRole("button", { name: "放大画布" }));
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(detectButton).toHaveAttribute("data-result", "success");
    expect(within(videoGeneration).getByRole("status", { name: /自动引用状态/ })).toHaveTextContent(
      "@站台参考图",
    );
  });

  it("已连接素材但立即重扫未命中时，显眼说明原因并展示可识别名称", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    setPromptText(promptInput, "机器人从雨夜中缓慢走来");

    const feedback = within(videoGeneration).getByRole("status", { name: /自动引用状态/ });
    await waitFor(() => expect(feedback).toHaveAttribute("data-state", "ready"));
    expect(feedback).not.toHaveClass("is-prominent");
    expect(feedback).toHaveTextContent("普通文字保持原样");

    const detectButton = within(videoGeneration).getByRole("button", {
      name: "识别素材名",
    });
    fireEvent.click(detectButton);
    expect(detectButton).toHaveAttribute("data-result", "scanning");

    await waitFor(() => {
      expect(feedback).toHaveAttribute("data-state", "no-match");
      expect(detectButton).toHaveAttribute("data-result", "no-match");
    });
    expect(feedback).toHaveClass("is-prominent");
    expect(feedback).toHaveTextContent("本次未匹配到已连接素材名");
    expect(feedback).toHaveTextContent("站台参考图");
    expect(feedback).toHaveTextContent("图片1");
  });

  it("手写显式 @ 引用停止后解析，并通过状态条和高亮 chip 明确反馈", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "镜头掠过@站台参考图后缓慢推进");
    expect(within(videoGeneration).getByRole("status", { name: /自动引用状态/ })).toHaveTextContent(
      "正在识别素材引用",
    );

    await waitFor(
      () => {
        expect(promptInput.querySelectorAll(".mention-chip")).toHaveLength(1);
        expect(
          within(videoGeneration).getByRole("status", { name: /自动引用状态/ }),
        ).toHaveTextContent("已自动引用 1 处素材");
      },
      { timeout: 1600 },
    );
    expect(promptInput.textContent?.replaceAll("\u200b", "")).toBe(
      "镜头掠过@站台参考图 · 图片1后缓慢推进",
    );
  });

  it("同名 @ 引用批量确认仅影响当前待确认项，新输入仍需明确选择", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 518, 222);
    const firstAsset = await addAssetNode("图片", "站台参考图", 148, 148);
    const secondAsset = await addAssetNode("图片", "站台参考图", 148, 333);
    connectAssetToGeneration(firstAsset, imageGeneration);
    connectAssetToGeneration(secondAsset, imageGeneration);
    const promptInput = within(imageGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "@站台参考图在雨中，随后@站台参考图切到近景");
    await waitFor(
      () => {
        expect(promptInput.querySelectorAll("[data-ambiguous-pattern]")).toHaveLength(2);
        expect(
          within(imageGeneration).getByRole("status", { name: /自动引用状态/ }),
        ).toHaveTextContent("检测到 2 处同名引用");
      },
      { timeout: 1_600 },
    );
    expect(promptInput.querySelector<HTMLElement>("[data-ambiguous-pattern]")?.textContent).toBe(
      "@站台参考图 · 待确认",
    );
    const chooser = within(imageGeneration).getByRole("group", {
      name: "选择“站台参考图”引用的具体素材",
    });
    expect(within(chooser).getByRole("option", { name: /选择 图片1/ })).toBeInTheDocument();
    expect(within(chooser).getByRole("option", { name: /选择 图片2/ })).toBeInTheDocument();

    // 未确认绝不猜测，也不调用后端生成。
    fireEvent.click(within(imageGeneration).getByRole("button", { name: "开始图片生成" }));
    expect(submittedGenerationCommands()).toHaveLength(0);
    expect(imageGeneration).toHaveTextContent(
      "匹配到 2 个同名对象。请点击黄色“待确认”引用并选择具体素材后再生成",
    );

    fireEvent.click(within(chooser).getByRole("option", { name: /选择 图片2/ }));
    await waitFor(() => {
      expect(promptInput.querySelector("[data-ambiguous-pattern]")).toBeNull();
      expect(promptInput.querySelectorAll("[data-mention-id]")).toHaveLength(2);
    });
    for (const chip of promptInput.querySelectorAll<HTMLElement>("[data-mention-id]")) {
      expect(chip.dataset["canvasNodeKey"]).toBe(secondAsset.dataset["connectionTarget"]);
      expect(chip).toHaveTextContent(/图片2/);
    }

    appendPromptText(promptInput, "，最后@站台参考图淡出");
    await waitFor(
      () => expect(promptInput.querySelectorAll("[data-ambiguous-pattern]")).toHaveLength(1),
      { timeout: 1_600 },
    );
    expect(promptInput.querySelectorAll("[data-mention-id]")).toHaveLength(2);
    const nextChooser = within(imageGeneration).getByRole("group", {
      name: "选择“站台参考图”引用的具体素材",
    });
    fireEvent.click(within(nextChooser).getByRole("option", { name: /选择 图片1/ }));

    fireEvent.click(within(imageGeneration).getByRole("button", { name: "开始图片生成" }));
    const mediaReferences = (
      submittedGenerationCommand()["prompt"] as readonly {
        kind: string;
        target?: { canvasNodeKey?: string };
      }[]
    ).filter((segment) => segment.kind === "media_reference");
    expect(mediaReferences).toHaveLength(3);
    expect(mediaReferences.map((segment) => segment.target?.canvasNodeKey)).toEqual([
      secondAsset.dataset["connectionTarget"],
      secondAsset.dataset["connectionTarget"],
      firstAsset.dataset["connectionTarget"],
    ]);
  });

  it("输入自动别名可绕过同名选择器并精确引用对应连线实例", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const firstAsset = await addAssetNode("图片", "站台参考图", 148, 148);
    const secondAsset = await addAssetNode("图片", "站台参考图", 148, 333);
    connectAssetToGeneration(firstAsset, videoGeneration);
    connectAssetToGeneration(secondAsset, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "让@图片2缓慢推进");
    await waitFor(() => expect(promptInput.querySelectorAll("[data-mention-id]")).toHaveLength(1), {
      timeout: 1_600,
    });
    expect(promptInput.querySelector("[data-ambiguous-pattern]")).toBeNull();
    expect(
      promptInput.querySelector<HTMLElement>("[data-mention-id]")?.dataset["canvasNodeKey"],
    ).toBe(secondAsset.dataset["connectionTarget"]);
  });

  it("单一素材输入稳定别名「@图片1」能被识别并绑定", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "让@图片1缓慢推进");
    await waitFor(() => expect(promptInput.querySelectorAll("[data-mention-id]")).toHaveLength(1), {
      timeout: 1_600,
    });
    expect(promptInput.querySelector("[data-ambiguous-pattern]")).toBeNull();
    const chip = promptInput.querySelector<HTMLElement>("[data-mention-id]")!;
    expect(chip.dataset["canvasNodeKey"]).toBe(assetNode.dataset["connectionTarget"]);
    expect(chip).toHaveTextContent(/图片1/);
    expect(within(videoGeneration).getByRole("status", { name: /自动引用状态/ })).toHaveTextContent(
      "已自动引用 1 处素材",
    );
  });

  it("手打带 @ 前缀的别名也能被识别并绑定", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "@图片1");
    await waitFor(() => expect(promptInput.querySelectorAll("[data-mention-id]")).toHaveLength(1), {
      timeout: 1_600,
    });
    expect(promptInput.querySelector("[data-ambiguous-pattern]")).toBeNull();
    const chip = promptInput.querySelector<HTMLElement>("[data-mention-id]")!;
    expect(chip.dataset["canvasNodeKey"]).toBe(assetNode.dataset["connectionTarget"]);
    expect(promptInput.textContent?.replaceAll("\u200b", "")).toBe("@站台参考图 · 图片1");
    expect(within(videoGeneration).getByRole("status", { name: /自动引用状态/ })).toHaveTextContent(
      "已自动引用 1 处素材",
    );
  });

  it("@ 候选菜单按别名「图片1」过滤并选中已连接素材", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "开场 ");
    fireEvent.keyDown(promptInput, { key: "@" });
    appendPromptText(promptInput, "@");

    const menu = await screen.findByRole("listbox", { name: "素材引用候选" });
    appendPromptText(promptInput, "图片1");
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));
    const option = within(menu).getByRole("option", { name: /站台参考图/ });
    expect(option).toHaveTextContent("图片1");

    fireEvent.click(option);
    expect(promptInput.textContent?.replaceAll("\u200b", "")).toBe("开场 @站台参考图 · 图片1");
    expect(promptInput.querySelectorAll(".mention-chip")).toHaveLength(1);
  });

  it("手打 @ 别名后关闭候选菜单，自动识别补扫并绑定素材", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "开场 ");
    fireEvent.keyDown(promptInput, { key: "@" });
    appendPromptText(promptInput, "@");

    const menu = await screen.findByRole("listbox", { name: "素材引用候选" });
    appendPromptText(promptInput, "图片1");
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));

    // 不选择菜单，直接关闭（Escape）：关闭后补扫应把 @图片1 转成引用 chip。
    fireEvent.keyDown(promptInput, { key: "Escape" });
    await waitFor(() => expect(promptInput.querySelectorAll("[data-mention-id]")).toHaveLength(1), {
      timeout: 1_600,
    });
    const chip = promptInput.querySelector<HTMLElement>("[data-mention-id]")!;
    expect(chip.dataset["canvasNodeKey"]).toBe(assetNode.dataset["connectionTarget"]);
    expect(promptInput.textContent?.replaceAll("\u200b", "")).toBe("开场 @站台参考图 · 图片1");
    expect(within(videoGeneration).getByRole("status", { name: /自动引用状态/ })).toHaveTextContent(
      "已自动引用 1 处素材",
    );
  });

  it("@ 候选菜单展示已连线素材的缩略图", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "开场 ");
    fireEvent.keyDown(promptInput, { key: "@" });
    appendPromptText(promptInput, "@");

    const menu = await screen.findByRole("listbox", { name: "素材引用候选" });
    appendPromptText(promptInput, "图片1");
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));

    const option = within(menu).getByRole("option", { name: /站台参考图/ });
    const thumbImage = option.querySelector<HTMLElement>(".prompt-mention__thumb img");
    expect(thumbImage).not.toBeNull();
    expect(thumbImage).toHaveAttribute(
      "src",
      `asset://localhost/video?src=${encodeURIComponent("https://cdn.example.com/station.jpg")}`,
    );
    expect(option.querySelector(".prompt-mention__thumb--fallback")).toBeNull();
  });

  it("@ 候选菜单中的参考视频素材展示中间帧缩略图", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("视频", "列车进站参考", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    setPromptText(promptInput, "开场 ");
    fireEvent.keyDown(promptInput, { key: "@" });
    appendPromptText(promptInput, "@");

    const menu = await screen.findByRole("listbox", { name: "素材引用候选" });
    appendPromptText(promptInput, "视频1");
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));

    const option = within(menu).getByRole("option", { name: /列车进站参考/ });
    // 候选视频不再当作图片加载：缩略图是中间帧，且不进入类型图标回退态。
    expect(option.querySelector(".prompt-mention__thumb img")).toBeNull();
    expect(option.querySelector(".prompt-mention__thumb--fallback")).toBeNull();
    const frame = option.querySelector<HTMLVideoElement>(".prompt-mention__thumb video")!;
    expect(frame).toHaveAttribute(
      "src",
      expect.stringContaining(encodeURIComponent("https://cdn.example.com/train.mp4")),
    );

    Object.defineProperties(frame, {
      duration: { value: 8, configurable: true },
      videoWidth: { value: 1920, configurable: true },
      videoHeight: { value: 1080, configurable: true },
    });
    fireEvent.loadedMetadata(frame);
    expect(frame.currentTime).toBe(4);
    fireEvent.seeked(frame);
    const thumbBox = option.querySelector<HTMLElement>(".prompt-mention__thumb")!;
    await waitFor(() => {
      expect(parseFloat(thumbBox.style.aspectRatio)).toBeCloseTo(1920 / 1080, 3);
    });
  });

  it("未命中或未连接素材时也给出明确的自动解析状态", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 518, 222);
    const promptInput = within(imageGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });

    expect(within(imageGeneration).getByRole("status", { name: /自动引用状态/ })).toHaveTextContent(
      "连接素材后，输入 @ 选择引用",
    );
    setPromptText(promptInput, "一段没有参考素材的普通提示词");
    await waitFor(
      () =>
        expect(
          within(imageGeneration).getByRole("status", { name: /自动引用状态/ }),
        ).toHaveTextContent("未连接素材，暂时无法引用"),
      { timeout: 1600 },
    );
  });

  it("解除连线后引用 chip 进入灰化态，重新连线后恢复", async () => {
    render(<App />);
    const videoGeneration = await addGenerationNode("视频", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, videoGeneration);
    await insertMention(videoGeneration, "站台参考图");
    const promptInput = within(videoGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    const chip = promptInput.querySelector<HTMLElement>(".mention-chip")!;
    const mentionId = chip.dataset["mentionId"];
    const currentChip = () =>
      promptInput.querySelector<HTMLElement>(`[data-mention-id="${mentionId}"]`)!;
    expect(chip).not.toHaveClass("is-stale");

    // 解除连线 → 灰化态标记，但引用数据保留。
    fireEvent.click(within(videoGeneration).getByRole("button", { name: "解除连线：站台参考图" }));
    await waitFor(() => expect(currentChip()).toHaveClass("is-stale"));
    expect(currentChip()).toHaveTextContent("@站台参考图");

    // 重新连线 → 恢复正常展示与 title。
    connectAssetToGeneration(assetNode, videoGeneration);
    await waitFor(() => expect(currentChip()).not.toHaveClass("is-stale"));
    expect(currentChip().title).toContain("站台参考图 · 图片1 · asset-image-1");
  });

  it("可从画布连线本身删除连接而保留两端节点", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, imageGeneration);

    // React Flow：单击连线即选中，选中后在其标签处出现删除按钮。
    const edge = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".react-flow__edge");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);
    fireEvent.click(
      await screen.findByRole("button", { name: "删除连线：站台参考图 → 图片生成节点" }),
    );

    expect(document.querySelector(".edge--asset-generation")).toBeNull();
    expect(document.body).toContainElement(assetNode);
    expect(document.body).toContainElement(imageGeneration);
    expect(
      within(imageGeneration).queryByRole("button", { name: "解除连线：站台参考图" }),
    ).not.toBeInTheDocument();
  });

  it("从提示词输入框切到连线后可直接按 Delete 删除", async () => {
    render(<App />);
    const imageGeneration = await addGenerationNode("图片", 518, 222);
    const assetNode = await addAssetNode("图片", "站台参考图", 148, 148);
    connectAssetToGeneration(assetNode, imageGeneration);

    const promptInput = within(imageGeneration).getByRole("textbox", {
      name: "提示词输入框，输入 @ 引用素材",
    });
    promptInput.focus();
    expect(promptInput).toHaveFocus();

    const edgeHitTarget = await screen.findByRole("button", {
      name: "选择连线：站台参考图 → 图片生成节点；按 Delete 删除",
    });
    fireEvent.click(edgeHitTarget);
    expect(edgeHitTarget).toHaveFocus();

    fireEvent.keyDown(document.activeElement!, { key: "Delete" });

    expect(document.querySelector(".edge--asset-generation")).toBeNull();
    expect(document.body).toContainElement(assetNode);
    expect(document.body).toContainElement(imageGeneration);
  });
});

describe("剧本创作与优化节点（桌面运行时）", () => {
  it("可添加、移除超过原大小限制的多模态素材，并保留空文件检查与请求传递", async () => {
    dialogOpenMock.mockResolvedValue([
      "C:\\project\\reference.png",
      "C:\\project\\interview.md",
      "C:\\project\\empty.md",
    ]);
    fileStatMock.mockImplementation((path: string) =>
      Promise.resolve({ isFile: true, size: path.endsWith("empty.md") ? 0 : 100 * 1024 * 1024 }),
    );
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        return Promise.resolve({
          optimizedPrompt: "# 素材改编稿\n\n第一场",
          rawModelOutput: "ok",
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    await screen.findByText("画布为空");
    const node = await addScreenplayNode(640, 400);

    expect(within(node).getByLabelText("剧本参考素材")).toBeInTheDocument();
    fireEvent.click(within(node).getByRole("button", { name: "添加多模态参考素材" }));
    await waitFor(() => expect(within(node).getByText("reference.png")).toBeInTheDocument());
    expect(within(node).getByText("interview.md")).toBeInTheDocument();
    expect(within(node).getByText("已添加 2 项")).toBeInTheDocument();
    expect(within(node).queryByText("empty.md")).not.toBeInTheDocument();

    const sendButton = within(node).getByRole("button", { name: "发送" });
    expect(sendButton).toBeEnabled();
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(getDocumentEditor(node, "当前剧本").value).toBe("# 素材改编稿\n\n第一场");
    });
    const call = invokeMock.mock.calls
      .filter(([command]) => command === "run_prompt_node")
      .at(-1)?.[1] as {
      command: {
        userPrompt: string;
        multimodalInputs: Array<Record<string, unknown>>;
      };
    };
    expect(call.command.userPrompt).toBe("请分析附带的参考素材，并据此创作或优化剧本。");
    expect(call.command.multimodalInputs).toEqual([
      expect.objectContaining({
        localPath: "C:\\project\\reference.png",
        displayName: "reference.png",
        kind: "image",
        mimeType: "image/png",
      }),
      expect.objectContaining({
        localPath: "C:\\project\\interview.md",
        displayName: "interview.md",
        kind: "document",
        mimeType: "text/markdown",
      }),
    ]);
    expect(within(node).getByText(/参考素材：reference\.png、interview\.md/)).toBeInTheDocument();

    const removeButton = await waitFor(() => {
      const button = within(node).getByRole("button", {
        name: "移除参考素材：reference.png",
      });
      expect(button).toBeEnabled();
      return button;
    });
    fireEvent.click(removeButton);
    await waitFor(() =>
      expect(
        within(node).queryByRole("button", { name: "移除参考素材：reference.png" }),
      ).not.toBeInTheDocument(),
    );
    expect(within(node).getByText("已添加 1 项")).toBeInTheDocument();
  });

  it("完整注入多轮历史并支持 Markdown 导出", async () => {
    let screenplayCall = 0;
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        screenplayCall += 1;
        return Promise.resolve({
          optimizedPrompt: screenplayCall === 1 ? "# 雨夜归人\n\n第一稿" : "# 雨夜归人\n\n第二稿",
          rawModelOutput: "ok",
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    await screen.findByText("画布为空");
    const node = await addScreenplayNode(640, 400);

    expect(within(node).getByText("双技能已内置")).toBeInTheDocument();
    expect(within(node).getByText(/每轮完整注入/)).toBeInTheDocument();
    const composer = within(node).getByRole("textbox", { name: "剧本对话消息" });
    fireEvent.change(composer, { target: { value: "写一个雨夜重逢短剧" } });
    fireEvent.click(within(node).getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(getDocumentEditor(node, "当前剧本").value).toBe("# 雨夜归人\n\n第一稿");
    });
    const firstCommand = invokeMock.mock.calls
      .filter(([command]) => command === "run_prompt_node")
      .at(-1)?.[1] as { command: Record<string, unknown> };
    expect(firstCommand.command).toMatchObject({
      mode: "screenplay",
      task: "generate",
      userPrompt: "写一个雨夜重逢短剧",
      contextHistory: [],
    });

    fireEvent.change(composer, { target: { value: "把结尾改成克制的开放式结局" } });
    fireEvent.click(within(node).getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(getDocumentEditor(node, "当前剧本").value).toBe("# 雨夜归人\n\n第二稿");
    });
    const secondCommand = invokeMock.mock.calls
      .filter(([command]) => command === "run_prompt_node")
      .at(-1)?.[1] as { command: { contextHistory: Array<{ role: string; content: string }> } };
    expect(secondCommand.command.contextHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "写一个雨夜重逢短剧" }),
        expect.objectContaining({ content: "# 雨夜归人\n\n第一稿" }),
        expect.objectContaining({ role: "当前剧本文档" }),
      ]),
    );

    expect(within(node).queryByRole("button", { name: /审计/ })).not.toBeInTheDocument();
    expect(within(node).getByRole("button", { name: "导出 Markdown 剧本文档" })).toBeEnabled();
  });

  it("编剧助手对话区与剧本预览框不参与节点拖拽，支持选中文字复制", async () => {
    render(<App />);
    await screen.findByText("画布为空");
    const node = await addScreenplayNode(640, 400);

    // 编剧助手多轮对话区：带 nodrag，避免拖拽把“选中文字”手势劫持为移动节点。
    const conversation = within(node).getByRole("log", { name: "剧本多轮对话" });
    expect(conversation).toHaveClass("nodrag");

    // 写入稿件后切到「预览」，预览框同样带 nodrag。
    fireEvent.change(getDocumentEditor(node, "当前剧本"), {
      target: { value: "# 雨夜归人\n\n第一场" },
    });
    fireEvent.click(within(node).getByRole("button", { name: "预览" }));
    const preview = within(node).getByRole("region", { name: "当前剧本预览" });
    expect(preview).toHaveClass("nodrag");
  });
});

describe("剧本转工业级分镜脚本节点（桌面运行时）", () => {
  it("可连接剧本节点，并把上游最新剧本文档作为分镜上下文", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        return Promise.resolve({
          optimizedPrompt: "# 雨夜归人 · 工业级分镜\n\n## SD01\n\n0-5s：24mm 建场镜头",
          rawModelOutput: "ok",
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    await screen.findByText("画布为空");
    const screenplay = await addScreenplayNode(360, 360);
    fireEvent.change(getDocumentEditor(screenplay, "当前剧本"), {
      target: { value: "# 雨夜归人\n\n林舟在暴雨中的站台等到了故人。" },
    });
    const storyboard = await addStoryboardNode(980, 360);

    connectViaHandles(screenplay, storyboard);

    await waitFor(() =>
      expect(document.querySelectorAll(".edge--screenplay-storyboard")).toHaveLength(1),
    );
    expect(within(storyboard).getByText("雨夜归人")).toBeInTheDocument();
    const sendButton = within(storyboard).getByRole("button", { name: "发送" });
    expect(sendButton).toBeEnabled();
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(getDocumentEditor(storyboard, "当前工业级分镜脚本").value).toContain("## SD01");
    });
    const command = invokeMock.mock.calls
      .filter(([name]) => name === "run_prompt_node")
      .at(-1)?.[1] as {
      command: {
        userPrompt: string;
        contextHistory: Array<{ role: string; content: string }>;
      };
    };
    expect(command.command.userPrompt).toBe("请将已连接的剧本转换为工业级分镜脚本。");
    expect(command.command.contextHistory).toEqual(
      expect.arrayContaining([
        {
          role: "已连接的上游 Markdown 剧本 · 雨夜归人",
          content: "# 雨夜归人\n\n林舟在暴雨中的站台等到了故人。",
        },
      ]),
    );

    fireEvent.click(within(storyboard).getByRole("button", { name: "解除剧本连线：雨夜归人" }));
    await waitFor(() =>
      expect(document.querySelector(".edge--screenplay-storyboard")).not.toBeInTheDocument(),
    );
  });

  it("每轮注入完整上下文并支持 Markdown 导出", async () => {
    let storyboardCall = 0;
    dialogSaveMock.mockResolvedValue("C:\\Exports\\工业级分镜脚本.md");
    invokeMock.mockImplementation((command) => {
      if (command === "run_prompt_node") {
        storyboardCall += 1;
        return Promise.resolve({
          optimizedPrompt:
            storyboardCall === 1
              ? "# 雨夜归人 · 工业级分镜\n\n## SD01\n\n0-5s：24mm 建场镜头"
              : "# 雨夜归人 · 工业级分镜\n\n## SD01\n\n0-6s：24mm 建场镜头，雨势加强",
          rawModelOutput: "ok",
        });
      }
      return baseInvokeImplementation(command);
    });

    render(<App />);
    await screen.findByText("画布为空");
    const node = await addStoryboardNode(640, 400);

    expect(within(node).getByText("V4.6 分镜技能已内置")).toBeInTheDocument();
    expect(within(node).getByText(/16 references · 每轮完整注入/)).toBeInTheDocument();
    const composer = within(node).getByRole("textbox", { name: "分镜对话消息" });
    fireEvent.change(composer, {
      target: { value: "把这份雨夜重逢剧本转成 9:16 的 Seedance 2.5 工业级分镜" },
    });
    fireEvent.click(within(node).getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(getDocumentEditor(node, "当前工业级分镜脚本").value).toContain("## SD01");
    });
    const firstCommand = invokeMock.mock.calls
      .filter(([command]) => command === "run_prompt_node")
      .at(-1)?.[1] as { command: Record<string, unknown> };
    expect(firstCommand.command).toMatchObject({
      mode: "storyboard",
      task: "generate",
      userPrompt: "把这份雨夜重逢剧本转成 9:16 的 Seedance 2.5 工业级分镜",
      contextHistory: [],
    });

    fireEvent.change(composer, { target: { value: "加强雨势并把 SD01 调整到 6 秒" } });
    fireEvent.click(within(node).getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(getDocumentEditor(node, "当前工业级分镜脚本").value).toContain("雨势加强");
    });
    const secondCommand = invokeMock.mock.calls
      .filter(([command]) => command === "run_prompt_node")
      .at(-1)?.[1] as { command: { contextHistory: Array<{ role: string; content: string }> } };
    expect(secondCommand.command.contextHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining("雨夜重逢剧本") as unknown as string,
        }),
        expect.objectContaining({
          content: expect.stringContaining("24mm 建场镜头") as unknown as string,
        }),
        expect.objectContaining({ role: "当前工业级分镜脚本" }),
      ]),
    );

    expect(within(node).queryByRole("button", { name: /审计/ })).not.toBeInTheDocument();
    const exportButton = within(node).getByRole("button", {
      name: "导出 Markdown 分镜脚本文档",
    });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    await waitFor(() =>
      expect(dialogSaveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [{ name: "Markdown 分镜脚本文档", extensions: ["md", "markdown"] }],
        }),
      ),
    );
    await waitFor(() =>
      expect(writeTextFileMock).toHaveBeenCalledWith(
        "C:\\Exports\\工业级分镜脚本.md",
        expect.stringContaining("雨势加强"),
      ),
    );
  });
});

describe("素材库分组与云端素材改名（桌面运行时）", () => {
  it("云端素材库展示分组选择：全部素材 + 各分组纯名称，不暴露令牌前缀", async () => {
    render(<App />);
    const groupSelect = await screen.findByLabelText("素材库分组");
    const labels = within(groupSelect)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toContain("全部素材");
    expect(labels).toContain("客户案例");
    expect(labels).toContain("默认分组 · 默认");
    for (const label of labels) {
      expect(label).not.toMatch(/user-/i);
      expect(label).not.toMatch(/token-/i);
    }
    expect(screen.getByRole("button", { name: "新建素材分组" })).toBeInTheDocument();
  });

  it("切换分组后按 group_id 重新拉取素材，切回全部素材恢复全量", async () => {
    render(<App />);
    await screen.findByLabelText("素材库分组");

    fireEvent.change(screen.getByLabelText("素材库分组"), { target: { value: "21" } });
    await waitFor(() => {
      const listCalls = invokeMock.mock.calls.filter(([command]) => command === "list_assets");
      const lastCall = listCalls.at(-1);
      expect(lastCall?.[1]).toEqual({
        command: {
          providerConnectionId: PROVIDER.id,
          pageNumber: 1,
          pageSize: 40,
          name: null,
          groupId: "21",
          kind: "image",
        },
      });
    });

    fireEvent.change(screen.getByLabelText("素材库分组"), { target: { value: "" } });
    await waitFor(() => {
      const listCalls = invokeMock.mock.calls.filter(([command]) => command === "list_assets");
      const lastCall = listCalls.at(-1);
      expect(lastCall?.[1]).toEqual({
        command: {
          providerConnectionId: PROVIDER.id,
          pageNumber: 1,
          pageSize: 40,
          name: null,
          groupId: null,
          kind: "image",
        },
      });
    });
  });

  it("新建分组：用户自定义名称，提交时去除首尾空白并写入新选项", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建素材分组" }));

    // 新建分组弹窗按需懒加载（deferredDialogs），CI 首触发时加载可能超过
    // testing-library 默认 1s 轮询超时，这里显式放宽；输入框是弹窗的同步子节点。
    const input = await screen.findByLabelText(/分组名称/, {}, { timeout: 5_000 });
    fireEvent.change(input, { target: { value: "  新品物料  " } });
    fireEvent.click(screen.getByRole("button", { name: "创建分组" }));

    await waitFor(() => {
      const createCall = invokeMock.mock.calls.find(
        ([command]) => command === "create_asset_group",
      );
      expect(createCall?.[1]).toEqual({
        command: {
          providerConnectionId: PROVIDER.id,
          name: "新品物料",
        },
      });
    });

    // mock 返回 id=22 name="新分组"；本地插入后选项立即可见，且被选中。
    const groupSelect = await screen.findByLabelText("素材库分组");
    await waitFor(() => {
      expect(within(groupSelect).getByRole("option", { name: "新分组" })).toBeInTheDocument();
    });
    expect(groupSelect).toHaveValue("22");
  });

  it("删除分组：两段式确认后调用 delete_asset_group，选中分组从下拉消失", async () => {
    render(<App />);
    const groupSelect = await screen.findByLabelText("素材库分组");

    // 选中「客户案例」（id=21）后出现删除按钮。
    fireEvent.change(groupSelect, { target: { value: "21" } });
    const deleteButton = await screen.findByRole("button", { name: "删除分组：客户案例" });

    // 第一次点击仅进入确认态（4 秒内二次点击才真正删除），不发起请求。
    fireEvent.click(deleteButton);
    screen.getByRole("button", { name: "确认删除分组：客户案例" });
    expect(invokeMock.mock.calls.some(([command]) => command === "delete_asset_group")).toBe(false);

    // 确认态下再次点击才调用删除接口。
    fireEvent.click(screen.getByRole("button", { name: "确认删除分组：客户案例" }));
    await waitFor(() => {
      const deleteCall = invokeMock.mock.calls.find(
        ([command]) => command === "delete_asset_group",
      );
      expect(deleteCall?.[1]).toEqual({
        command: { providerConnectionId: PROVIDER.id, id: "21" },
      });
    });

    // 删除后「客户案例」选项消失，下拉回到「全部素材」。
    await waitFor(() => {
      expect(
        within(groupSelect).queryByRole("option", { name: "客户案例" }),
      ).not.toBeInTheDocument();
    });
    expect(groupSelect).toHaveValue("");
  });

  it("素材详情内可重命名云端素材：保存后调用 rename_asset 并关闭弹窗", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "预览图片素材详情：站台参考图" }));

    // 素材详情弹窗按需懒加载（deferredDialogs），CI 首触发时加载可能超过
    // testing-library 默认 1s 轮询超时，这里显式放宽；按钮是弹窗的同步子节点。
    const dialog = await screen.findByRole("dialog", { name: "站台参考图" }, { timeout: 5_000 });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /重命名素材：站台参考图$/,
      }),
    );
    const input = screen.getByRole("textbox", { name: "站台参考图的新名称" });
    fireEvent.change(input, { target: { value: "站台新参考名" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const renameCall = invokeMock.mock.calls.find(([command]) => command === "rename_asset");
      expect(renameCall?.[1]).toEqual({
        command: {
          providerConnectionId: PROVIDER.id,
          id: "asset-image-1",
          name: "站台新参考名",
        },
      });
    });
    // 成功后关闭详情弹窗并重新拉取素材。
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "list_assets").length,
    ).toBeGreaterThan(0);
  });
});

describe("任意节点多来源参数传递", () => {
  it("两个剧本经素材中转同时进入分镜，媒体和最新文本完整提交，断开后不再使用", async () => {
    invokeMock.mockImplementation((command) =>
      command === "run_prompt_node"
        ? Promise.resolve({ optimizedPrompt: "# 分镜交付\n完成", rawModelOutput: "ok" })
        : baseInvokeImplementation(command),
    );
    render(<App />);
    const first = await addScreenplayNode(350, 250);
    const second = await addScreenplayNode(900, 250);
    fireEvent.change(getDocumentEditor(first, "当前剧本"), {
      target: { value: "# 甲剧本\n甲的正文" },
    });
    fireEvent.change(getDocumentEditor(second, "当前剧本"), {
      target: { value: "# 乙剧本\n乙的正文" },
    });
    const relay = await addAssetNode("图片", "站台参考图", 150, 400);
    const target = await addStoryboardNode(980, 360);
    connectViaHandles(first, relay);
    connectViaHandles(second, relay);
    connectViaHandles(relay, target);
    await waitFor(() => expect(within(target).getByText("甲剧本")).toBeInTheDocument());
    expect(within(target).getByText("乙剧本")).toBeInTheDocument();
    expect(within(target).getByText("站台参考图")).toBeInTheDocument();
    fireEvent.change(getDocumentEditor(first, "当前剧本"), {
      target: { value: "# 甲剧本\n甲的最新正文" },
    });
    fireEvent.click(within(target).getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(getDocumentEditor(target, "当前工业级分镜脚本").value).toContain("分镜交付"),
    );
    const sent = invokeMock.mock.calls
      .filter(([command]) => command === "run_prompt_node")
      .at(-1)?.[1] as {
      command: {
        contextHistory: { content: string }[];
        referenceInputs: { target: { canvasNodeKey: string } }[];
      };
    };
    expect(sent.command.contextHistory.map((entry) => entry.content)).toEqual(
      expect.arrayContaining(["# 甲剧本\n甲的最新正文", "# 乙剧本\n乙的正文"]),
    );
    expect(sent.command.referenceInputs).toHaveLength(1);
    expect(sent.command.referenceInputs[0]?.target.canvasNodeKey).toBe(
      rfWrapperOf(relay).dataset["id"],
    );
    fireEvent.click(within(target).getByRole("button", { name: "解除素材连线：站台参考图" }));
    await waitFor(() => expect(within(target).queryByText("甲剧本")).not.toBeInTheDocument());
    expect(document.body).toContainElement(relay);
  });

  it("分镜与剧本同时向图片节点传入文本，断开其中一个保留另一份", async () => {
    render(<App />);
    const screenplay = await addScreenplayNode(350, 250);
    const storyboard = await addStoryboardNode(1000, 250);
    const target = await addGenerationNode("图片", 980, 360);
    fireEvent.change(getDocumentEditor(screenplay, "当前剧本"), {
      target: { value: "场景：清晨站台" },
    });
    fireEvent.change(getDocumentEditor(storyboard, "当前工业级分镜脚本"), {
      target: { value: "镜头：低角度远景" },
    });
    connectViaHandles(screenplay, target);
    connectViaHandles(storyboard, target);
    const editor = within(target).getByRole("textbox", { name: "提示词输入框，输入 @ 引用素材" });
    await waitFor(() => expect(editor).toHaveTextContent("场景：清晨站台"));
    expect(editor).toHaveTextContent("镜头：低角度远景");
    fireEvent.click(within(target).getByRole("button", { name: "开始图片生成" }));
    await waitFor(() => expect(submittedGenerationCommands()).toHaveLength(1));
    expect(JSON.stringify(submittedGenerationCommands()[0])).toContain("场景：清晨站台");
    expect(JSON.stringify(submittedGenerationCommands()[0])).toContain("镜头：低角度远景");
    const edge = screen.getByRole("button", { name: /选择连线：场景：清晨站台.*图片生成节点/ });
    fireEvent.click(edge);
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    await waitFor(() => expect(editor).not.toHaveTextContent("场景：清晨站台"));
    expect(editor).toHaveTextContent("镜头：低角度远景");
  });
});
