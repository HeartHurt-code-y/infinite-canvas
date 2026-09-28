import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../App";
import type {
  CanvasDocumentRecord,
  GenerationTaskSummary,
  SaveCanvasDocumentCommand,
  StartGenerationCommand,
} from "../../../lib/backend";
import { defaultModelOperationSchema } from "../../../lib/modelCapabilities";
import { createWhiteModelStudioDraft, type BlenderRenderJob } from "../../../lib/whiteModelStudio";
import type { CanvasDocumentV2 } from "../../canvas/canvasStore";
import type { AgentAction, AgentState } from "./agentTypes";

// jsdom has no WebGL. The actual panel, registry, controller, workspace host, and persistence run.
vi.mock("../WhiteModelViewport", () => ({
  WhiteModelViewport: () => <div data-testid="agent-scene-preview" />,
}));

const provider = {
  id: "agent-provider",
  displayName: "创作供应商",
  adapterId: "moyu_v1",
  baseUrl: "https://example.test",
  apiKeyRef: "test-key",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};
const textModelId = "doubao-seed-1-8-251228";
const videoModelId = "doubao-seedance-2-5-260628";
const definitions = [
  {
    id: textModelId,
    displayName: "助手文本模型",
    remoteModelId: textModelId,
    operations: defaultModelOperationSchema(textModelId, ["text_generation"]),
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: videoModelId,
    displayName: "Seedance 2.5",
    remoteModelId: videoModelId,
    operations: defaultModelOperationSchema(videoModelId, ["video_generation"]),
    createdAt: 1,
    updatedAt: 1,
  },
];
const records = new Map<string, CanvasDocumentRecord>();
const saves: CanvasDocumentV2[] = [];
const callbacks = new Map<number, (payload: unknown) => unknown>();
let callbackId = 0;
let plannedScene = createWhiteModelStudioDraft().plan;
let replyOverride: { message: string; actions: readonly AgentAction[] } | null = null;
let generationTasks: readonly GenerationTaskSummary[] = [];
const submittedTaskId = "agent-generation-submitted-task";
const job: BlenderRenderJob = {
  jobId: "a93db98c-cf64-4ad1-a718-49b9eb89961c",
  status: "succeeded",
  progress: 100,
  message: "白模动画已导出",
  error: null,
  videoPath: "C:/rendered/agent-white-model/output.mp4",
  previewPath: "C:/rendered/agent-white-model/preview.png",
  projectPath: "C:/rendered/agent-white-model/scene.blend",
  width: 960,
  height: 540,
  durationSeconds: 8,
  createdAt: 1,
  updatedAt: 2,
};

const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();

function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case "list_canvas_documents":
      return Promise.resolve(
        [...records.values()].map(({ id, title, revision, createdAt, updatedAt }) => ({
          id,
          title,
          revision,
          createdAt,
          updatedAt,
        })),
      );
    case "get_canvas_document": {
      const record = records.get(String(args?.["canvasId"]));
      return record
        ? Promise.resolve(structuredClone(record))
        : Promise.reject(
            Object.assign(new Error("canvas document does not exist"), { kind: "not_found" }),
          );
    }
    case "save_canvas_document": {
      const command = structuredClone(args?.["command"]) as SaveCanvasDocumentCommand;
      const previous = records.get(command.id);
      const revision = previous?.revision ?? 0;
      if (command.expectedRevision != null && command.expectedRevision !== revision) {
        return Promise.reject(new Error("canvas revision conflict"));
      }
      const record: CanvasDocumentRecord = {
        id: command.id,
        title: command.title,
        document: command.document,
        revision: revision + 1,
        createdAt: previous?.createdAt ?? 1,
        updatedAt: revision + 2,
      };
      records.set(record.id, record);
      saves.push(record.document as CanvasDocumentV2);
      return Promise.resolve(structuredClone(record));
    }
    case "get_workspace_ui_prefs":
      return Promise.resolve({});
    case "list_provider_connections":
      return Promise.resolve([provider]);
    case "list_model_definitions":
      return Promise.resolve(definitions);
    case "list_provider_model_bindings":
      return Promise.resolve(
        definitions.map((definition) => ({
          providerConnectionId: provider.id,
          modelDefinitionId: definition.id,
          tokenGroup: null,
          enabledOperations:
            definition.id === textModelId ? ["text_generation"] : ["video_generation"],
          remoteModelId: null,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        })),
      );
    case "list_generation_tasks":
      return Promise.resolve({ items: generationTasks, nextCursorCreatedBefore: null });
    case "start_generation":
      return Promise.resolve(submittedTaskId);
    case "list_assets":
    case "list_asset_groups":
      return Promise.resolve([]);
    case "count_assets_by_kind":
      return Promise.resolve({ image: 0, video: 0, audio: 0 });
    case "run_prompt_node": {
      const reply = JSON.stringify(
        replyOverride ?? {
          message: "先创建视频节点，再设置并渲染人物走动白模。",
          actions: [
            {
              id: "video",
              tool: "canvas.create_node",
              args: { kind: "video", text: "人物在画面中从左走到右" },
              dependsOn: [],
            },
            {
              id: "scene",
              tool: "blender.set_scene",
              args: { nodeKey: "$video", scene: plannedScene },
              dependsOn: ["video"],
            },
            {
              id: "render",
              tool: "blender.render",
              args: { nodeKey: "$video" },
              dependsOn: ["scene"],
            },
          ],
        },
      );
      return Promise.resolve({ optimizedPrompt: reply, rawModelOutput: reply });
    }
    case "start_blender_render":
    case "get_blender_render":
      return Promise.resolve(job);
    case "get_blender_engine":
      return Promise.resolve({
        available: true,
        executablePath: "C:/bundled/blender.exe",
        version: "Blender 4.5.13",
        message: "已就绪",
      });
    case "plugin:event|listen":
      return Promise.resolve(++callbackId);
    default:
      return Promise.resolve(null);
  }
}

function latestDocument(): CanvasDocumentV2 {
  const record = [...records.values()].at(-1);
  if (!record) throw new Error("Canvas not saved yet");
  return record.document as CanvasDocumentV2;
}

beforeEach(() => {
  window.localStorage.clear();
  records.clear();
  saves.length = 0;
  callbacks.clear();
  callbackId = 0;
  plannedScene = createWhiteModelStudioDraft().plan;
  replyOverride = null;
  generationTasks = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(invoke);
  const target = window as unknown as Record<string, unknown>;
  target["__TAURI_INTERNALS__"] = {
    invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
    transformCallback: (callback: (payload: unknown) => unknown) => {
      const id = ++callbackId;
      callbacks.set(id, callback);
      return id;
    },
    convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
    metadata: { currentWindow: { label: "main" } },
  };
  target["__TAURI_EVENT_PLUGIN_INTERNALS__"] = { unregisterListener: () => undefined };
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(async () => {
  // Keep Tauri event unregistration available until RTL's asynchronous cleanup finishes.
  await act(async () => {
    await Promise.resolve();
  });
});

async function openPanel(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByRole("button", { name: "新建画布" })).toBeEnabled());
  fireEvent.click(await screen.findByRole("button", { name: "打开创作助手" }));
  const panel = screen.getByRole("complementary", { name: "创作助手" });
  await waitFor(() =>
    expect(
      within(panel).getByRole("option", { name: "助手文本模型 · 创作供应商" }),
    ).toBeInTheDocument(),
  );
  fireEvent.change(within(panel).getByRole("combobox", { name: "对话模型" }), {
    target: { value: JSON.stringify([provider.id, textModelId]) },
  });
  return panel;
}

async function propose(panel: HTMLElement, text: string): Promise<HTMLElement> {
  fireEvent.change(within(panel).getByRole("textbox", { name: "给创作助手的消息" }), {
    target: { value: text },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "发送" }));
  const approve = await within(panel).findByRole("button", { name: "确认并执行" });
  await waitFor(() => expect(approve).toBeEnabled());
  return approve;
}

describe("CanvasAgent workspace integration", () => {
  it("requires approval, persists the white-model draft and local output, and restores without replay", async () => {
    const view = render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "新建画布" })).toBeEnabled());
    fireEvent.click(await screen.findByRole("button", { name: "打开创作助手" }));
    const panel = screen.getByRole("complementary", { name: "创作助手" });
    await waitFor(() =>
      expect(
        within(panel).getByRole("option", { name: "助手文本模型 · 创作供应商" }),
      ).toBeInTheDocument(),
    );
    fireEvent.change(within(panel).getByRole("combobox", { name: "对话模型" }), {
      target: { value: JSON.stringify([provider.id, textModelId]) },
    });
    fireEvent.change(within(panel).getByRole("textbox", { name: "给创作助手的消息" }), {
      target: { value: "制作一段人物从左走到右的白模" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "发送" }));
    const approve = await within(panel).findByRole("button", { name: "确认并执行" });
    await waitFor(() => expect(approve).toBeEnabled());
    expect(latestDocument().genNodes).toHaveLength(0);
    expect(latestDocument().outputNodes ?? []).toHaveLength(0);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "start_blender_render"),
    ).toHaveLength(0);
    expect(within(panel).getByTestId("agent-scene-preview")).toBeInTheDocument();
    const request = invokeMock.mock.calls.find(([command]) => command === "run_prompt_node")?.[1]?.[
      "command"
    ];
    expect(request).toMatchObject({
      mode: "canvas_agent",
      modelDefinitionId: textModelId,
      providerConnectionId: provider.id,
    });

    fireEvent.click(approve);
    await waitFor(() => {
      expect(within(panel).queryByRole("alert")?.textContent ?? "no error").toBe("no error");
      expect(latestDocument().outputNodes).toHaveLength(1);
    });
    await within(panel).findByText(
      "本次确认的步骤已完成。可以继续描述修改要求；已提交的生成任务可在画布和历史中查看。",
    );
    await waitFor(() => expect((latestDocument().agent as AgentState).status).toBe("idle"));
    const saved = latestDocument();
    const node = saved.genNodes[0]!;
    if (node.kind !== "video") throw new Error("Expected a video node");
    expect(node.config.whiteModelStudio).toMatchObject({
      mode: "create",
      jobId: job.jobId,
      plan: plannedScene,
    });
    expect(node.config.whiteModelStudio?.jobInputSignature).toBeTruthy();
    const output = saved.outputNodes![0]!;
    expect(output).toMatchObject({
      origin: "white_model",
      mediaType: "video",
      taskId: job.jobId,
      finalPath: job.videoPath,
    });
    expect(saved.assetEdges).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromKey: output.key, toKey: node.key })]),
    );
    expect(node.config.whiteModelControl?.source).toMatchObject({
      key: output.key,
      target: {
        kind: "local_file",
        path: job.videoPath,
        canvasNodeKey: output.key,
        mediaType: "video",
      },
    });
    expect(
      saves.some(
        (document) =>
          document.genNodes.some(
            (entry) =>
              entry.kind === "video" &&
              entry.config.whiteModelStudio?.plan.objects[0]?.id === plannedScene.objects[0]!.id,
          ) && !document.outputNodes?.length,
      ),
    ).toBe(true);
    expect((saved.agent as AgentState).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "制作一段人物从左走到右的白模" }),
        expect.objectContaining({ role: "user", content: "确认执行上面的制作计划。" }),
        expect.objectContaining({ role: "tool" }),
      ]),
    );
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "start_blender_render"),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.find(([command]) => command === "start_blender_render")?.[1]?.[
        "request"
      ],
    ).toMatchObject({
      executablePath: null,
      sourceBlendPath: null,
      plan: plannedScene,
      bake: { frameCount: plannedScene.durationSeconds * plannedScene.fps },
    });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "start_generation"),
    ).toHaveLength(0);

    const refinement = {
      interpolation: "smooth",
      keyframes: [
        { time: 0, pose: "crouch" },
        { time: 2, pose: "stand", targets: { rightHand: { position: [-0.2, -0.1, 1] } } },
      ],
    };
    replyOverride = {
      message: "先蹲下，再起身挥右手。",
      actions: [
        {
          id: "refine",
          tool: "blender.refine_motion",
          dependsOn: [],
          args: { nodeKey: node.key, actorId: plannedScene.objects[0]!.id, refinement },
        },
      ],
    };
    const refineApprove = await propose(panel, "让人物先蹲下，再起身挥右手");
    expect(within(panel).getByTestId("agent-scene-preview")).toBeInTheDocument();
    expect(node.config.whiteModelStudio?.plan.objects[0]!.motionRefinement).toBeUndefined();
    fireEvent.click(refineApprove);
    await waitFor(() => {
      const updated = latestDocument().genNodes[0]!;
      expect(
        updated.kind !== "prompt" &&
          updated.config.whiteModelStudio?.plan.objects[0]!.motionRefinement,
      ).toEqual(refinement);
      expect((latestDocument().agent as AgentState).status).toBe("idle");
    });

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "新建画布" })).toBeEnabled());
    const restoredPanel = await screen.findByRole("complementary", { name: "创作助手" });
    await within(restoredPanel).findByText("制作一段人物从左走到右的白模");
    expect(
      within(restoredPanel).queryByRole("button", { name: "确认并执行" }),
    ).not.toBeInTheDocument();
    expect(latestDocument().outputNodes).toHaveLength(1);
    expect(latestDocument().genNodes[0]?.key).toBe(node.key);
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_prompt_node")).toHaveLength(
      2,
    );
    const restored = latestDocument().genNodes[0]!;
    expect(
      restored.kind !== "prompt" &&
        restored.config.whiteModelStudio?.plan.objects[0]!.motionRefinement,
    ).toEqual(refinement);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "start_blender_render"),
    ).toHaveLength(1);
  });

  it("synchronizes the upstream prompt before one approved video submission and resets model settings", async () => {
    const promptA = "镜头平稳推进，晨光透过玻璃照亮一只白色陶杯。";
    const promptB = "这里的旧文字应被上游提示词替换。";
    replyOverride = {
      message: "创建提示词与视频节点，选择视频模型，连接后提交一次生成。",
      actions: [
        {
          id: "prompt",
          tool: "canvas.create_node",
          args: { kind: "prompt", text: promptA },
          dependsOn: [],
        },
        {
          id: "video",
          tool: "canvas.create_node",
          args: { kind: "video", text: promptB },
          dependsOn: [],
        },
        {
          id: "model",
          tool: "canvas.set_model",
          args: { nodeKey: "$video", providerId: provider.id, modelDefinitionId: videoModelId },
          dependsOn: ["video"],
        },
        {
          id: "connect",
          tool: "canvas.connect",
          args: { fromKey: "$prompt", toKey: "$video" },
          dependsOn: ["prompt", "model"],
        },
        {
          id: "generate",
          tool: "generation.start",
          args: { nodeKey: "$video" },
          dependsOn: ["connect"],
        },
      ],
    };
    render(<App />);
    const panel = await openPanel();
    const approve = await propose(panel, "建立提示词到视频的创作链，并用上游文字生成一次视频");
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "start_generation"),
    ).toHaveLength(0);
    fireEvent.click(approve);
    await waitFor(() => {
      expect(within(panel).queryByRole("alert")?.textContent ?? "no error").toBe("no error");
      expect(
        latestDocument().outputNodes?.some((output) => output.taskId === submittedTaskId),
      ).toBe(true);
      expect((latestDocument().agent as AgentState).status).toBe("idle");
    });
    const starts = invokeMock.mock.calls.filter(([command]) => command === "start_generation");
    expect(starts).toHaveLength(1);
    const submitted = starts[0]![1]?.["command"] as StartGenerationCommand;
    const saved = latestDocument();
    const promptNode = saved.genNodes.find((node) => node.kind === "prompt")!;
    const videoNode = saved.genNodes.find((node) => node.kind === "video")!;
    expect(submitted).toMatchObject({
      sourceNodeId: videoNode.key,
      providerConnectionId: provider.id,
      modelDefinitionId: videoModelId,
      operation: "video_generation",
      generationCount: 1,
      prompt: [{ kind: "text", text: promptA }],
    });
    expect(JSON.stringify(submitted.prompt)).not.toContain(promptB);
    expect(saved.promptContents[videoNode.key]?.items).toEqual([{ kind: "text", text: promptA }]);
    expect(videoNode.config).toMatchObject({
      modelSelection: { providerId: provider.id, modelDefinitionId: videoModelId },
      parameterValues: {},
      seedanceTaskMode: "auto",
      mediaRoles: {},
    });
    expect(saved.assetEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromKey: promptNode.key, toKey: videoNode.key }),
      ]),
    );
    const result = saved.outputNodes!.find((output) => output.taskId === submittedTaskId)!;
    expect(result).toMatchObject({
      sourceNodeId: videoNode.key,
      taskId: submittedTaskId,
      mediaType: "video",
      finalPath: null,
    });
    expect(
      (saved.agent as AgentState).messages.some(
        (message) => message.role === "tool" && message.content.includes(submittedTaskId),
      ),
    ).toBe(true);
  });

  it("blocks new submissions while an existing task is unknown or interrupted", async () => {
    replyOverride = {
      message: "准备一个视频节点。",
      actions: [
        {
          id: "video",
          tool: "canvas.create_node",
          args: { kind: "video", text: "保留原任务的创作内容" },
          dependsOn: [],
        },
      ],
    };
    render(<App />);
    const panel = await openPanel();
    fireEvent.click(await propose(panel, "创建一个视频节点"));
    await waitFor(() => {
      expect(latestDocument().genNodes).toHaveLength(1);
      expect((latestDocument().agent as AgentState).status).toBe("idle");
    });
    const nodeKey = latestDocument().genNodes[0]!.key;
    const canvasId = [...records.keys()][0]!;
    replyOverride = {
      message: "提交这个视频节点生成一次。",
      actions: [{ id: "generate", tool: "generation.start", args: { nodeKey }, dependsOn: [] }],
    };
    for (const status of ["unknown", "interrupted"] as const) {
      generationTasks = [
        {
          id: `existing-${status}`,
          canvasId,
          sourceNodeId: nodeKey,
          operation: "video_generation",
          status,
          queryHealth: "degraded",
          providerConnectionId: provider.id,
          providerDisplayNameSnapshot: provider.displayName,
          modelDefinitionId: videoModelId,
          remoteModelIdSnapshot: videoModelId,
          remoteTaskId: "remote-existing-task",
          progress: null,
          tokens: null,
          createdAt: 1,
          updatedAt: 2,
          completedAt: null,
        },
      ];
      const approve = await propose(panel, `继续这个状态为 ${status} 的节点`);
      fireEvent.click(approve);
      await waitFor(() =>
        expect(within(panel).getByRole("alert")).toHaveTextContent(
          "请先在任务历史中查询或恢复，避免重复提交",
        ),
      );
      await waitFor(() => expect((latestDocument().agent as AgentState).status).toBe("idle"));
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "start_generation"),
      ).toHaveLength(0);
      expect(latestDocument().outputNodes ?? []).toHaveLength(0);
    }
    const guardQueries = invokeMock.mock.calls.filter(([command, args]) => {
      const query = args?.["query"] as { sourceNodeId?: string; limit?: number } | undefined;
      return (
        command === "list_generation_tasks" && query?.sourceNodeId === nodeKey && query.limit === 1
      );
    });
    expect(guardQueries).toHaveLength(2);
    for (const [, args] of guardQueries) {
      const query = args?.["query"] as { statuses: readonly string[] };
      expect(query).toMatchObject({
        canvasId,
        sourceNodeId: nodeKey,
      });
      expect(query.statuses).toEqual(expect.arrayContaining(["unknown", "interrupted"]));
    }
  });
});
