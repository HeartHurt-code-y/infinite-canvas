import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type { CanvasDocumentV2 } from "./features/canvas/canvasStore";
import type { RecordedWorkflowRunner } from "./features/workspace/workflowHistoryExecution";
import {
  CANVAS_ID,
  type KnowledgeVideoWorkflowNodeData,
} from "./features/workspace/workspaceModel";
import type {
  CanvasDocumentClient,
  GenerationTaskClient,
  PickedPromptMaterial,
  ProviderCatalogEntry,
} from "./lib/backend";
import type * as BackendModule from "./lib/backend";
import type * as WorkflowHistoryModule from "./lib/workflowHistory";
import type { WorkflowHistoryClient, WorkflowHistoryRecord } from "./lib/workflowHistory";
import { catalog, node } from "./test/videoWorkflowFixtures";
import {
  createReverseVideoCheckpoint,
  createReverseVideoOptions,
} from "./features/workspace/reverseVideoWorkflowModel";
import { createCommerceOptions } from "./features/workspace/commerceWorkflowModel";
import { createXhsCoverOptions } from "./features/workspace/xhsCoverWorkflowModel";

const mocks = vi.hoisted(() => ({
  run: vi.fn<RecordedWorkflowRunner["run"]>(),
  historyList: vi.fn<WorkflowHistoryClient["list"]>(),
  historyGet: vi.fn<WorkflowHistoryClient["get"]>(),
  recover: vi.fn<WorkflowHistoryClient["recover"]>(),
  getCanvas: vi.fn<CanvasDocumentClient["get"]>(),
  listCanvases: vi.fn<CanvasDocumentClient["list"]>(),
  saveCanvas: vi.fn<CanvasDocumentClient["save"]>(),
  loadProviders: vi.fn<() => Promise<readonly ProviderCatalogEntry[]>>(),
  listTasks: vi.fn<GenerationTaskClient["list"]>(),
  pickMaterials: vi.fn<typeof BackendModule.pickPromptMultimodalFiles>(),
}));

vi.mock("./features/workspace/workflowHistoryExecution", () => ({
  createRecordedWorkflowRunner: () => ({ run: mocks.run }),
}));
vi.mock("./lib/workflowHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowHistoryModule>()),
  workflowHistoryClient: {
    list: mocks.historyList,
    get: mocks.historyGet,
    recover: mocks.recover,
    save: vi.fn(),
  },
}));
vi.mock("./lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof BackendModule>();
  return {
    ...actual,
    isDesktopRuntime: () => true,
    frontendLog: vi.fn(),
    loadProviderCatalog: mocks.loadProviders,
    pickPromptMultimodalFiles: mocks.pickMaterials,
    canvasDocumentClient: {
      list: mocks.listCanvases,
      get: mocks.getCanvas,
      save: mocks.saveCanvas,
    },
    generationClient: { ...actual.generationClient, list: mocks.listTasks },
    subscribeGenerationEvents: () => () => {},
    subscribeStagingEvents: () => () => {},
    assetLibraryClient: { ...actual.assetLibraryClient, list: () => Promise.resolve([]) },
    tosStagingClient: {
      ...actual.tosStagingClient,
      listLocalAssets: () =>
        Promise.resolve({
          items: [],
          total: 0,
          page: 1,
          pageSize: 40,
          kindTotals: { image: 0, video: 0, audio: 0 },
        }),
    },
  };
});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    destroy: () => Promise.resolve(),
  }),
}));

function historyRecord(): WorkflowHistoryRecord {
  const snapshot = node();
  return {
    id: "saved-workflow-run",
    canvasId: CANVAS_ID,
    sourceNodeId: snapshot.key,
    workflowKind: "knowledge",
    title: "暂停的 RAG 知识视频",
    status: "paused",
    progress: 42,
    message: "镜头已保存，可从断点继续",
    error: null,
    nodeSnapshot: {
      ...snapshot,
      config: {
        ...snapshot.config,
        historyRunId: "saved-workflow-run",
        checkpoint: {
          ...snapshot.config.checkpoint,
          phase: "paused",
          runId: "original-run",
          lastActivePhase: "generating",
          shotRuns: {
            "01": {
              shotId: "01",
              videoTaskId: "original-video-task",
              clipPath: "C:\\saved\\clip-01.mp4",
              retryCount: 0,
              qcStatus: "passed",
            },
          },
        },
      },
    },
    models: [],
    attemptCount: 1,
    revision: 3,
    createdAt: 1,
    updatedAt: 2,
  };
}

function canvasDocument(nodes: readonly KnowledgeVideoWorkflowNodeData[] = []): CanvasDocumentV2 {
  return {
    version: 2,
    assetNodes: [],
    genNodes: [],
    resultNodes: [],
    assetEdges: [],
    knowledgeVideoWorkflowNodes: nodes,
    view: { zoom: 100, pan: { x: 0, y: 0 } },
    promptContents: {},
  };
}

function referenceMaterial(
  displayName: string,
  overrides: Partial<PickedPromptMaterial> = {},
): PickedPromptMaterial {
  return {
    localPath: `C:\\references\\${displayName}`,
    displayName,
    kind: "document",
    mimeType: "text/markdown",
    byteSize: 1024,
    ...overrides,
  };
}

function loadCanvasNodes(nodes: readonly KnowledgeVideoWorkflowNodeData[]) {
  mocks.getCanvas.mockResolvedValue({
    id: CANVAS_ID,
    title: "测试画布",
    document: canvasDocument(nodes),
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function pickWorkflowMaterials(materials: readonly PickedPromptMaterial[]) {
  mocks.pickMaterials.mockResolvedValueOnce(materials);
  const button = screen.getByRole("button", { name: "添加工作流多模态参考素材" });
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "工作流参考素材" })).toHaveAttribute(
      "aria-busy",
      "false",
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  const record = historyRecord();
  mocks.loadProviders.mockResolvedValue(catalog);
  mocks.historyList.mockResolvedValue({ items: [record], nextCursor: null });
  mocks.historyGet.mockResolvedValue({ record, events: [], tasks: [] });
  mocks.recover.mockResolvedValue(0);
  mocks.listTasks.mockResolvedValue({ items: [], nextCursorCreatedBefore: null });
  mocks.pickMaterials.mockReset().mockResolvedValue([]);
  mocks.listCanvases.mockResolvedValue([
    { id: CANVAS_ID, title: "测试画布", revision: 1, createdAt: 1, updatedAt: 1 },
  ]);
  mocks.getCanvas.mockResolvedValue({
    id: CANVAS_ID,
    title: "测试画布",
    document: canvasDocument(),
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  mocks.saveCanvas.mockImplementation((command) =>
    Promise.resolve({
      id: CANVAS_ID,
      title: command.title,
      document: command.document,
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
    }),
  );
  mocks.run.mockImplementation((request) => {
    request.onProgress({
      phase: request.node.config.checkpoint.phase,
      progress: 0,
      message: "测试工作流已返回",
      error: null,
    });
    return Promise.resolve(request.node.config.checkpoint);
  });
});

async function resumeFromHistory() {
  fireEvent.click(screen.getByRole("button", { name: "打开历史记录" }));
  // 全量并行运行时主线程负载高，历史数据渲染可能超过默认 1s 超时，放宽到 10s。
  fireEvent.click(await screen.findByRole("tab", { name: "工作流" }, { timeout: 10_000 }));
  fireEvent.click(await screen.findByRole("button", { name: "从断点继续" }, { timeout: 10_000 }));
  await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce(), { timeout: 10_000 });
}

describe("workflow history canvas integration", () => {
  it("reuses a historical workflow with unchanged live edges without retaining detached copies", async () => {
    const record = historyRecord();
    const asset: CanvasDocumentV2["assetNodes"][number] = {
      key: "live-image",
      assetId: "asset-image",
      providerConnectionId: "original-provider",
      source: "cloud",
      kind: "image",
      name: "已连图片",
      previewUrl: null,
      videoUrl: null,
      x: 0,
      y: 0,
    };
    const reference = {
      displayName: asset.name,
      target: {
        kind: "asset" as const,
        assetId: asset.assetId,
        providerConnectionId: asset.providerConnectionId,
        mediaType: "image" as const,
        canvasNodeKey: asset.key,
      },
    };
    const savedRecord = {
      ...record,
      nodeSnapshot: {
        ...record.nodeSnapshot,
        config: { ...record.nodeSnapshot.config, connectedMaterials: [reference] },
      },
    };
    const document = {
      ...canvasDocument([record.nodeSnapshot]),
      assetNodes: [asset],
      assetEdges: [
        {
          id: `${asset.key}->${record.sourceNodeId}`,
          fromKey: asset.key,
          toKey: record.sourceNodeId,
        },
      ],
    };
    mocks.getCanvas.mockResolvedValue({
      id: CANVAS_ID,
      title: "已有连线",
      document,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    mocks.historyList.mockResolvedValue({ items: [savedRecord], nextCursor: null });
    mocks.historyGet.mockResolvedValue({ record: savedRecord, events: [], tasks: [] });
    render(<App />);
    await screen.findByLabelText("知识视频制作要求");
    await resumeFromHistory();
    expect(screen.getAllByLabelText("知识视频制作要求")).toHaveLength(1);
    expect(mocks.run.mock.calls[0]![0].node.config.connectedMaterials).toEqual([reference]);
    expect(
      screen.queryByRole("button", { name: "移除历史参考素材：已连图片" }),
    ).not.toBeInTheDocument();
    const unlink = screen.getByRole("button", { name: "断开工作流素材：已连图片" });
    await waitFor(() => expect(unlink).toBeEnabled());
    fireEvent.click(unlink);
    fireEvent.click(screen.getByRole("button", { name: "继续制作" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    expect(mocks.run.mock.calls[1]![0].node.config.connectedMaterials ?? []).toEqual([]);
  });

  it("snapshots more than eight connected image, audio and video identities and drops disconnected inputs on the next run", async () => {
    const workflow = node();
    const assets: CanvasDocumentV2["assetNodes"] = ["image", "audio", "video"].map(
      (kind, index) => ({
        key: `reference-${kind}`,
        assetId: `asset-${kind}`,
        providerConnectionId: "original-asset-provider",
        source: index === 1 ? "local" : "cloud",
        kind: kind as "image" | "audio" | "video",
        name: `参考${kind}`,
        previewUrl: null,
        videoUrl: null,
        x: 0,
        y: index * 250,
      }),
    );
    const additionalAssets = Array.from({ length: 9 }, (_, index) => ({
      ...assets[0]!,
      key: `additional-reference-${index}`,
      assetId: `additional-asset-${index}`,
      name: `补充参考 ${index}`,
    }));
    const allAssets = [...assets, ...additionalAssets];
    const document = {
      ...canvasDocument([workflow]),
      assetNodes: allAssets,
      assetEdges: allAssets.map((asset) => ({
        id: `${asset.key}->${workflow.key}`,
        fromKey: asset.key,
        toKey: workflow.key,
      })),
    };
    mocks.getCanvas.mockResolvedValue({
      id: CANVAS_ID,
      title: "素材连线",
      document,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    render(<App />);
    const region = await screen.findByRole("region", { name: "工作流参考素材" });
    expect(within(region).getByText(/全部参考资料 12 项/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    expect(mocks.run.mock.calls[0]![0].node.config.connectedMaterials).toEqual([
      {
        displayName: "参考image",
        target: {
          kind: "asset",
          assetId: "asset-image",
          providerConnectionId: "original-asset-provider",
          mediaType: "image",
          canvasNodeKey: "reference-image",
        },
      },
      {
        displayName: "参考audio",
        target: {
          kind: "local_asset",
          stagingJobId: "asset-audio",
          mediaType: "audio",
          canvasNodeKey: "reference-audio",
        },
      },
      {
        displayName: "参考video",
        target: {
          kind: "asset",
          assetId: "asset-video",
          providerConnectionId: "original-asset-provider",
          mediaType: "video",
          canvasNodeKey: "reference-video",
        },
      },
      ...additionalAssets.map((asset) => ({
        displayName: asset.name,
        target: {
          kind: "asset",
          assetId: asset.assetId,
          providerConnectionId: "original-asset-provider",
          mediaType: "image",
          canvasNodeKey: asset.key,
        },
      })),
    ]);
    const unlink = within(region).getByRole("button", { name: "断开工作流素材：参考audio" });
    await waitFor(() => expect(unlink).toBeEnabled());
    fireEvent.click(unlink);
    expect(within(region).queryByText("参考audio")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    expect(
      mocks.run.mock.calls[1]![0].node.config.connectedMaterials?.map(
        (item) => item.target.mediaType,
      ),
    ).toEqual(["image", "video", ...additionalAssets.map(() => "image")]);
    await waitFor(
      () => {
        const saved = mocks.saveCanvas.mock.calls.at(-1)?.[0].document as
          CanvasDocumentV2 | undefined;
        expect(saved?.assetEdges).toHaveLength(11);
        expect(saved?.assetNodes).toHaveLength(12);
        expect(saved?.knowledgeVideoWorkflowNodes?.[0]?.config.connectedMaterials ?? []).toEqual(
          [],
        );
      },
      { timeout: 3000 },
    );
  });

  it("restores historical media references without source nodes and lets the user remove them", async () => {
    const record = historyRecord();
    const reference = {
      displayName: "历史旁白",
      target: {
        kind: "local_asset" as const,
        stagingJobId: "saved-audio",
        mediaType: "audio" as const,
      },
    };
    const snapshot = {
      ...record.nodeSnapshot,
      config: { ...record.nodeSnapshot.config, connectedMaterials: [reference] },
    };
    const savedRecord = { ...record, nodeSnapshot: snapshot };
    mocks.historyList.mockResolvedValue({ items: [savedRecord], nextCursor: null });
    mocks.historyGet.mockResolvedValue({ record: savedRecord, events: [], tasks: [] });
    render(<App />);
    await resumeFromHistory();
    expect(mocks.run.mock.calls[0]![0].node.config.connectedMaterials).toEqual([reference]);
    const remove = await screen.findByRole("button", { name: "移除历史参考素材：历史旁白" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    expect(
      screen.queryByRole("button", { name: "移除历史参考素材：历史旁白" }),
    ).not.toBeInTheDocument();
  });

  it("restores the reverse workflow as one node and preserves its completed download", async () => {
    const previous = historyRecord();
    const options = { ...createReverseVideoOptions(), sourceUrl: "https://v.douyin.com/example/" };
    const reverseVideo = {
      ...createReverseVideoCheckpoint(),
      downloadJobId: "saved-download",
      videoPath: "C:\\saved\\original.mp4",
      step: "analysis" as const,
    };
    const record: WorkflowHistoryRecord = {
      ...previous,
      workflowKind: "reverseVideo",
      title: "暂停的短视频反推",
      nodeSnapshot: {
        ...previous.nodeSnapshot,
        config: {
          ...previous.nodeSnapshot.config,
          reverseVideo: options,
          checkpoint: { ...previous.nodeSnapshot.config.checkpoint, reverseVideo },
        },
      },
    };
    mocks.historyList.mockResolvedValue({ items: [record], nextCursor: null });
    mocks.historyGet.mockResolvedValue({ record, events: [], tasks: [] });
    render(<App />);
    await waitFor(() => expect(mocks.getCanvas).toHaveBeenCalledWith(CANVAS_ID));
    await resumeFromHistory();

    const request = mocks.run.mock.calls[0]![0];
    expect(request.resume).toBe(true);
    expect(request.newHistory).toBe(false);
    expect(request.node.config.historyRunId).toBe(record.id);
    expect(request.node.config.reverseVideo).toEqual(options);
    expect(request.node.config.checkpoint.reverseVideo).toEqual(reverseVideo);
    expect(
      await screen.findByRole("button", { name: "查看短视频反推工作流历史记录" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("知识视频制作要求")).not.toBeInTheDocument();
  });

  it("restores one missing node from paused history and resumes the original task/run identities", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.getCanvas).toHaveBeenCalledWith(CANVAS_ID));
    expect(screen.queryByLabelText("知识视频制作要求")).not.toBeInTheDocument();
    await resumeFromHistory();
    expect(await screen.findByLabelText("知识视频制作要求")).toHaveValue(
      historyRecord().nodeSnapshot.config.brief,
    );
    expect(screen.getAllByLabelText("知识视频制作要求")).toHaveLength(1);
    const request = mocks.run.mock.calls[0]![0];
    expect(request.resume).toBe(true);
    expect(request.newHistory).toBe(false);
    expect(request.node.config.historyRunId).toBe("saved-workflow-run");
    expect(request.node.config.checkpoint.runId).toBe("original-run");
    expect(request.node.config.checkpoint.shotRuns["01"]?.videoTaskId).toBe("original-video-task");
    expect(request.node.config.checkpoint.shotRuns["01"]?.clipPath).toBe("C:\\saved\\clip-01.mp4");
    expect(request.providerCatalog).toEqual(catalog);
  });

  it("preserves an existing edited node and restores history into a separate node", async () => {
    const original = historyRecord().nodeSnapshot;
    const edited = {
      ...original,
      config: { ...original.config, brief: "我刚修改的全新主题，不能覆盖" },
    };
    mocks.getCanvas.mockResolvedValue({
      id: CANVAS_ID,
      title: "测试画布",
      document: canvasDocument([edited]),
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    render(<App />);
    expect(await screen.findByDisplayValue(edited.config.brief)).toBeInTheDocument();
    await resumeFromHistory();
    expect(screen.getByDisplayValue(edited.config.brief)).toBeInTheDocument();
    expect(await screen.findByDisplayValue(original.config.brief)).toBeInTheDocument();
    expect(screen.getAllByLabelText("知识视频制作要求")).toHaveLength(2);
    const request = mocks.run.mock.calls[0]![0];
    expect(request.node.key).not.toBe(edited.key);
    expect(request.node.config.historyRunId).toBe("saved-workflow-run");
    expect(request.node.config.checkpoint.shotRuns["01"]?.videoTaskId).toBe("original-video-task");
  });
});

describe("workflow reference material integration", () => {
  it("adds and removes references, deduplicates local paths, and executes with the latest metadata", async () => {
    loadCanvasNodes([node()]);
    render(<App />);
    await screen.findByLabelText("知识视频制作要求");
    const image = referenceMaterial("reference.png", { kind: "image", mimeType: "image/png" });
    const document = referenceMaterial("interview.md");
    await pickWorkflowMaterials([
      image,
      document,
      { ...image, localPath: image.localPath.toUpperCase() },
    ]);

    expect(mocks.pickMaterials).toHaveBeenCalledWith({ title: "为工作流添加参考素材" });
    const materials = screen.getByRole("region", { name: "工作流参考素材" });
    expect(within(materials).getByText(image.displayName)).toBeInTheDocument();
    expect(within(materials).getByText(document.displayName)).toBeInTheDocument();
    expect(within(materials).getAllByRole("button", { name: /移除工作流参考素材/ })).toHaveLength(
      2,
    );

    fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    expect(mocks.run.mock.calls[0]![0].node.config.materials).toEqual([image, document]);
    const remove = await screen.findByRole("button", {
      name: `移除工作流参考素材：${image.displayName}`,
    });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    expect(within(materials).queryByText(image.displayName)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    expect(mocks.run.mock.calls[1]![0].node.config.materials).toEqual([document]);
  });

  it("saves only reference metadata and restores it after reopening the canvas", async () => {
    loadCanvasNodes([node()]);
    const { unmount } = render(<App />);
    await screen.findByLabelText("知识视频制作要求");
    const materials = [
      referenceMaterial("voice.wav", { kind: "audio", mimeType: "audio/wav", byteSize: 4096 }),
      referenceMaterial("scene.mp4", { kind: "video", mimeType: "video/mp4", byteSize: 8192 }),
    ];
    await pickWorkflowMaterials(materials);
    await waitFor(
      () => {
        const saved = mocks.saveCanvas.mock.calls.at(-1)?.[0].document as
          CanvasDocumentV2 | undefined;
        expect(saved?.knowledgeVideoWorkflowNodes?.[0]?.config.materials).toEqual(materials);
      },
      { timeout: 3000 },
    );
    const saved = mocks.saveCanvas.mock.calls.at(-1)![0].document as CanvasDocumentV2;
    const savedMaterials = saved.knowledgeVideoWorkflowNodes![0]!.config.materials;
    expect(savedMaterials?.map((item) => Object.keys(item).sort())).toEqual(
      materials.map(() => ["byteSize", "displayName", "kind", "localPath", "mimeType"]),
    );

    unmount();
    loadCanvasNodes(saved.knowledgeVideoWorkflowNodes!);
    render(<App />);
    const region = await screen.findByRole("region", { name: "工作流参考素材" });
    expect(within(region).getByText("voice.wav")).toBeInTheDocument();
    expect(within(region).getByText("scene.mp4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    expect(mocks.run.mock.calls[0]![0].node.config.materials).toEqual(materials);
  });

  it("leaves references intact when selection is cancelled and displays picker failures", async () => {
    const material = referenceMaterial("existing.md");
    const current = node();
    loadCanvasNodes([{ ...current, config: { ...current.config, materials: [material] } }]);
    render(<App />);
    const region = await screen.findByRole("region", { name: "工作流参考素材" });
    await pickWorkflowMaterials([]);
    expect(within(region).getByText(material.displayName)).toBeInTheDocument();
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();

    mocks.pickMaterials.mockRejectedValueOnce(new Error("无法读取参考素材：文件已被移动"));
    fireEvent.click(screen.getByRole("button", { name: "添加工作流多模态参考素材" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "无法读取参考素材：文件已被移动",
    );
    expect(within(region).getByText(material.displayName)).toBeInTheDocument();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("accepts references beyond the old single and total byte limits while skipping empty files", async () => {
    const current = node();
    const existing = referenceMaterial("large.md", { byteSize: 14 * 1024 * 1024 - 1024 });
    loadCanvasNodes([{ ...current, config: { ...current.config, materials: [existing] } }]);
    render(<App />);
    const region = await screen.findByRole("region", { name: "工作流参考素材" });
    const accepted = referenceMaterial("last.md");
    const large = referenceMaterial("large-reference.md", { byteSize: 100 * 1024 * 1024 });
    const overflow = referenceMaterial("overflow.md", { byteSize: 1 });
    await pickWorkflowMaterials([
      referenceMaterial("empty.md", { byteSize: 0 }),
      large,
      accepted,
      overflow,
    ]);
    expect(within(region).getByText(accepted.displayName)).toBeInTheDocument();
    expect(within(region).queryByText("empty.md")).not.toBeInTheDocument();
    expect(within(region).getByText(large.displayName)).toBeInTheDocument();
    expect(within(region).getByText(overflow.displayName)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    expect(mocks.run.mock.calls[0]![0].node.config.materials).toEqual([
      existing,
      large,
      accepted,
      overflow,
    ]);
  });

  it.each(["commerce", "xhsCover"] as const)(
    "preserves every %s dedicated and common reference beyond eight items while bytes remain available",
    async (kind) => {
      const current = node();
      const images = Array.from({ length: 7 }, (_, index) =>
        referenceMaterial(`product-${index}.png`, { kind: "image", mimeType: "image/png" }),
      );
      const config =
        kind === "commerce"
          ? { ...current.config, commerce: { ...createCommerceOptions(), materials: images } }
          : {
              ...current.config,
              xhsCover: {
                ...createXhsCoverOptions(),
                portraits: images.slice(0, 2),
                materials: images.slice(2),
              },
            };
      loadCanvasNodes([{ ...current, config }]);
      render(<App />);
      const region = await screen.findByRole("region", { name: "工作流参考素材" });
      const accepted = referenceMaterial("brief.md");
      const ninth = referenceMaterial("ninth.md");
      const shared = { ...images[0]!, localPath: images[0]!.localPath.toUpperCase() };
      await pickWorkflowMaterials([shared, accepted, ninth]);
      expect(within(region).getByText(accepted.displayName)).toBeInTheDocument();
      expect(within(region).getByText(shared.displayName)).toBeInTheDocument();
      expect(within(region).getByText(/全部参考资料 9 项/)).toBeInTheDocument();
      expect(within(region).getByText("ninth.md")).toBeInTheDocument();
      expect(
        within(region).getByRole("button", { name: "添加工作流多模态参考素材" }),
      ).toBeEnabled();
      expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
      await waitFor(
        () => {
          const saved = mocks.saveCanvas.mock.calls.at(-1)?.[0].document as
            CanvasDocumentV2 | undefined;
          expect(saved?.knowledgeVideoWorkflowNodes?.[0]?.config.materials).toEqual([
            shared,
            accepted,
            ninth,
          ]);
        },
        { timeout: 3000 },
      );
    },
  );

  it.each([
    ["commerce", "添加商品资料", "商品图片与文档"],
    ["portrait", "添加人物参考图", "人物参考图"],
    ["material", "添加补充素材", "补充素材"],
  ] as const)(
    "accepts large %s files through the dedicated picker and passes them to execution",
    async (role, buttonName, regionName) => {
      const current = node();
      const portrait = referenceMaterial("existing-portrait.png", {
        kind: "image",
        mimeType: "image/png",
      });
      const config =
        role === "commerce"
          ? { ...current.config, commerce: { ...createCommerceOptions(), productName: "测试商品" } }
          : {
              ...current.config,
              xhsCover: {
                ...createXhsCoverOptions(),
                title: "测试封面",
                deliverable: "prompt" as const,
                portraits: role === "material" ? [portrait] : [],
              },
            };
      loadCanvasNodes([{ ...current, config }]);
      render(<App />);
      const region = await screen.findByRole("region", { name: regionName });
      const large = referenceMaterial(`${role}-large.png`, {
        kind: "image",
        mimeType: "image/png",
        byteSize: 150 * 1024 * 1024,
      });
      mocks.pickMaterials.mockResolvedValueOnce([
        large,
        { ...large, localPath: large.localPath.toUpperCase() },
        referenceMaterial("empty.png", { kind: "image", mimeType: "image/png", byteSize: 0 }),
      ]);
      fireEvent.click(within(region).getByRole("button", { name: buttonName }));
      expect(await within(region).findByText(large.displayName)).toBeInTheDocument();
      expect(within(region).queryByText("empty.png")).not.toBeInTheDocument();
      const start = screen.getByRole("button", { name: "开始制作" });
      await waitFor(() => expect(start).toBeEnabled());
      fireEvent.click(start);
      await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
      const submitted = mocks.run.mock.calls[0]![0].node.config;
      expect(
        role === "commerce"
          ? submitted.commerce?.materials
          : role === "portrait"
            ? submitted.xhsCover?.portraits
            : submitted.xhsCover?.materials,
      ).toEqual([large]);
    },
  );
});
