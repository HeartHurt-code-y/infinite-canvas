import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiMediaJob } from "../../lib/aiMedia";
import type * as AiMediaModule from "../../lib/aiMedia";
import type * as RuntimeComponentsModule from "../../lib/runtimeComponents";
import { AiMediaPanel } from "./AiMediaPanel";
import { publishArtifactNameChange } from "./artifactNameSync";
import {
  publishRuntimeComponentsChanged,
  RUNTIME_COMPONENTS_REQUEST_EVENT,
} from "../../lib/runtimeComponents";

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(() => true),
  runtimeStatus: vi.fn(),
  importRuntime: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  start: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  rename: vi.fn(),
  export: vi.fn(),
  open: vi.fn(),
  ensureFeature: vi.fn(),
}));
vi.mock("../../lib/backend", () => ({
  isDesktopRuntime: mocks.desktop,
  toMediaSrc: (path: string) => `asset://${path}`,
  formatRawBackendError: (reason: unknown) =>
    reason instanceof Error ? reason.message : String(reason),
}));
vi.mock("../../lib/aiMedia", async (importOriginal) => ({
  ...(await importOriginal<typeof AiMediaModule>()),
  aiMediaClient: {
    runtimeStatus: mocks.runtimeStatus,
    importRuntime: mocks.importRuntime,
    list: mocks.list,
    get: mocks.get,
    start: mocks.start,
    retry: mocks.retry,
    cancel: mocks.cancel,
    rename: mocks.rename,
  },
}));
vi.mock("./desktopActions", () => ({ exportArtifactToDesktop: mocks.export }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("../../lib/runtimeComponents", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeComponentsModule>()),
  ensureRuntimeFeatureInstalled: mocks.ensureFeature,
}));

const source = {
  name: "第01集_镜头12.mp4",
  target: {
    kind: "local_file" as const,
    path: "C:/source/original.mp4",
    canvasNodeKey: "original-card",
    mediaType: "video" as const,
  },
};
const runtime = {
  ready: true,
  videoDepthReady: true,
  audioSeparationReady: true,
  version: "1",
  rootPath: "C:/runtime",
};
const audioStreams = [
  { index: 2, codec: "aac", language: "chi", channels: 2, sampleRate: 48000 },
  { index: 4, codec: "aac", language: "eng", channels: 2, sampleRate: 48000 },
];
const completedJob: AiMediaJob = {
  jobId: "ai-restored",
  source: source.target,
  sourceIdentity: "original-content-sha256",
  name: "已完成镜头",
  operation: "video_depth",
  mode: "quality",
  startSeconds: 1,
  endSeconds: 5,
  depthMaxSide: 480,
  device: "auto",
  status: "completed",
  progress: 100,
  createdAt: 1,
  updatedAt: 2,
  outputs: [
    {
      resultIndex: 0,
      role: "depth_video",
      kind: "video",
      path: "C:/jobs/ai-restored/depth.mp4",
      name: "镜头12_深度",
      mimeType: "video/mp4",
      durationSeconds: 4,
    },
    {
      resultIndex: 1,
      role: "depth_data",
      kind: "data",
      path: "C:/jobs/ai-restored/depth.zip",
      name: "镜头12_深度数据",
      mimeType: "application/zip",
      durationSeconds: 4,
    },
    {
      resultIndex: 2,
      role: "manifest",
      kind: "data",
      path: "C:/jobs/ai-restored/manifest.json",
      name: "镜头12_信息",
      mimeType: "application/json",
      durationSeconds: 4,
    },
  ],
};

function renderPanel(props: Partial<Parameters<typeof AiMediaPanel>[0]> = {}) {
  const onUseOutput = vi.fn<(output: unknown, job: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  );
  return {
    ...render(
      <AiMediaPanel
        source={source}
        sourceIdentity="original-content-sha256"
        startSeconds={2.5}
        endSeconds={8}
        audioStreamIndex={2}
        audioStreams={audioStreams}
        onUseOutput={onUseOutput}
        {...props}
      />,
    ),
    onUseOutput,
  };
}

describe("AiMediaPanel", () => {
  it("opens unified component management and restores readiness without starting a task", async () => {
    mocks.runtimeStatus.mockResolvedValueOnce({
      ...runtime,
      ready: false,
      videoDepthReady: false,
      audioSeparationReady: false,
    });
    const user = userEvent.setup();
    const event = vi.fn();
    window.addEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    try {
      renderPanel();
      await screen.findByText("轻量本地组件尚未就绪");
      await user.clear(screen.getByRole("textbox", { name: "AI 产物名称" }));
      await user.type(screen.getByRole("textbox", { name: "AI 产物名称" }), "保留我的镜头名称");
      await user.click(screen.getByRole("button", { name: "安装或导入 AI 组件" }));
      expect((event.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        featureId: "ai-media-lite",
      });
      act(() => publishRuntimeComponentsChanged());
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeEnabled(),
      );
      expect(screen.getByRole("textbox", { name: "AI 产物名称" })).toHaveValue("保留我的镜头名称");
      expect(mocks.start).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(RUNTIME_COMPONENTS_REQUEST_EVENT, event);
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureFeature.mockResolvedValue(true);
    mocks.desktop.mockReturnValue(true);
    mocks.runtimeStatus.mockResolvedValue(runtime);
    mocks.importRuntime.mockResolvedValue(runtime);
    mocks.list.mockResolvedValue([]);
    mocks.start.mockResolvedValue({
      ...completedJob,
      mode: "lite",
      status: "processing",
      outputs: [],
    });
    mocks.retry.mockResolvedValue({
      ...completedJob,
      status: "processing",
      outputs: [],
      updatedAt: 4,
    });
    mocks.cancel.mockResolvedValue({
      ...completedJob,
      status: "cancelled",
      outputs: [],
      updatedAt: 5,
    });
    mocks.get.mockResolvedValue(completedJob);
    mocks.rename.mockImplementation((_id: string, resultIndex: number, name: string) =>
      Promise.resolve({
        ...completedJob,
        updatedAt: 6,
        outputs: completedJob.outputs.map((output) =>
          output.resultIndex === resultIndex ? { ...output, name } : output,
        ),
      }),
    );
    mocks.export.mockResolvedValue("C:/delivery/saved.zip");
    mocks.open.mockResolvedValue("C:/offline-package");
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  it("checks the selected engine and FFmpeg dependency before starting", async () => {
    mocks.ensureFeature.mockResolvedValue(false);
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "开始连续视频深度" }));
    expect(mocks.ensureFeature).toHaveBeenCalledWith("ai-media-lite");
    expect(await screen.findByText(/AI 媒体处理所需组件尚未就绪/)).toBeInTheDocument();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("keeps processing unavailable when the offline package is missing and can import it", async () => {
    mocks.runtimeStatus.mockResolvedValue({
      ...runtime,
      ready: false,
      videoDepthReady: false,
      audioSeparationReady: false,
      error: "离线包未安装",
    });
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText("离线包未安装")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "导入轻量本地离线包" }));
    expect(mocks.importRuntime).toHaveBeenCalledWith("C:/offline-package", "lite");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeEnabled(),
    );
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("passes the parent's measured source selection and explicit depth/device settings", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeEnabled(),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "深度视频尺寸" }), "720");
    await user.selectOptions(screen.getByRole("combobox", { name: "AI 处理设备" }), "cpu");
    await user.click(screen.getByRole("button", { name: "开始连续视频深度" }));
    expect(mocks.start).toHaveBeenCalledWith({
      source: source.target,
      sourceIdentity: "original-content-sha256",
      name: "第01集_镜头12",
      startSeconds: 2.5,
      endSeconds: 8,
      operation: "video_depth",
      mode: "lite",
      depthMaxSide: 720,
      device: "cpu",
    });
  });

  it("selects an independent global stream for AI audio separation and rejects silent sources", async () => {
    const user = userEvent.setup();
    const view = renderPanel();
    await screen.findByText("轻量本地组件已就绪 · 1");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "AI 处理方式" }),
      "audio_separation",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "分离音轨" }), "4");
    await user.click(screen.getByRole("button", { name: "开始AI 人声／伴奏分离" }));
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "audio_separation",
        audioStreamIndex: 4,
        source: source.target,
      }),
    );
    view.rerender(
      <AiMediaPanel
        source={source}
        startSeconds={2.5}
        endSeconds={8}
        sourceIdentity="original-content-sha256"
        audioStreams={[]}
        onUseOutput={view.onUseOutput}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始AI 人声／伴奏分离" })).toBeDisabled(),
    );
  });

  it("retains recovered results, adds only media to the canvas and saves numeric depth as an attachment", async () => {
    mocks.list.mockResolvedValue([completedJob]);
    const user = userEvent.setup();
    const { onUseOutput } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "加入画布" }));
    expect(onUseOutput).toHaveBeenCalledWith(completedJob.outputs[0], completedJob);
    expect(screen.getByRole("button", { name: "已加入画布" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "原始深度数据" }));
    expect(screen.queryByRole("button", { name: "加入画布" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存原始深度数据" }));
    expect(mocks.export).toHaveBeenCalledWith(
      "C:/jobs/ai-restored/depth.zip",
      "镜头12_深度数据.zip",
    );
  });

  it("keeps canonical renames in the result tabs and in exported filenames", async () => {
    mocks.list.mockResolvedValue([completedJob]);
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "修改 AI 产物名称" }));
    const nameInput = screen.getByRole("textbox", { name: "修改 AI 产物名称" });
    await user.clear(nameInput);
    await user.type(nameInput, "第01集_连续深度");
    await user.click(screen.getByRole("button", { name: "保存名称" }));
    expect(mocks.rename).toHaveBeenCalledWith("ai-restored", 0, "第01集_连续深度");
    expect(await screen.findByText("第01集_连续深度")).toBeInTheDocument();
    act(() => {
      publishArtifactNameChange({
        taskId: "ai-restored",
        finalPath: completedJob.outputs[0]!.path,
        name: "画布内的新名称",
      });
    });
    await user.click(screen.getByRole("button", { name: "保存深度视频" }));
    expect(mocks.export).toHaveBeenCalledWith(completedJob.outputs[0]!.path, "画布内的新名称.mp4");
  });

  it("retries persisted paused jobs with their existing identity and surfaces failure", async () => {
    mocks.list.mockResolvedValue([
      { ...completedJob, status: "paused", outputs: [], error: "应用重启后暂停" },
    ]);
    mocks.retry.mockRejectedValue(new Error("原视频内容已变化"));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "重新处理选区" }));
    expect(mocks.retry).toHaveBeenCalledWith("ai-restored");
    expect(await screen.findByText("原视频内容已变化")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("所选 AI 任务详情")).getByText("已暂停"),
    ).toBeInTheDocument();
  });

  it("does not start without a measured content identity or with an invalid selection", async () => {
    const view = renderPanel({ sourceIdentity: undefined });
    await screen.findByText("轻量本地组件已就绪 · 1");
    expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeDisabled();
    view.rerender(
      <AiMediaPanel
        source={source}
        sourceIdentity="sha256"
        startSeconds={9}
        endSeconds={2}
        onUseOutput={view.onUseOutput}
      />,
    );
    expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeDisabled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("avoids native calls in browser mode", () => {
    mocks.desktop.mockReturnValue(false);
    renderPanel();
    expect(screen.getByText("AI 媒体处理需要在桌面应用中运行。")).toBeInTheDocument();
    expect(mocks.runtimeStatus).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("disables new tasks if refreshing a previously ready runtime fails", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeEnabled(),
    );
    mocks.runtimeStatus.mockRejectedValueOnce(new Error("组件完整性校验失败"));
    await user.click(screen.getByRole("button", { name: "刷新 AI 状态" }));
    expect(await screen.findByText("组件完整性校验失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeDisabled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("keeps a cancelled task terminal when an earlier progress read returns late", async () => {
    const activeJob: AiMediaJob = {
      ...completedJob,
      status: "processing",
      outputs: [],
      updatedAt: 3,
    };
    mocks.list.mockResolvedValue([activeJob]);
    let resolveProgress!: (job: AiMediaJob) => void;
    mocks.get.mockReturnValue(
      new Promise<AiMediaJob>((resolve) => {
        resolveProgress = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(activeJob.jobId), { timeout: 2500 });
    await user.click(screen.getByRole("button", { name: "取消 AI 任务" }));
    expect(mocks.cancel).toHaveBeenCalledWith(activeJob.jobId);
    act(() => {
      resolveProgress({ ...activeJob, updatedAt: 4, progress: 50 });
    });
    expect(await screen.findByRole("button", { name: "重试 AI 任务" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "取消 AI 任务" })).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText("所选 AI 任务详情")).getByText("已取消"),
    ).toBeInTheDocument();
  });

  it("starts with the lightweight engine and resets incompatible devices when switching engines", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getByRole("combobox", { name: "处理引擎" })).toHaveValue("lite");
    await screen.findByText("轻量本地组件已就绪 · 1");
    expect(mocks.runtimeStatus).toHaveBeenCalledWith("lite");
    await user.selectOptions(screen.getByRole("combobox", { name: "AI 处理设备" }), "directml");
    await user.selectOptions(screen.getByRole("combobox", { name: "处理引擎" }), "quality");
    expect(screen.getByRole("combobox", { name: "AI 处理设备" })).toHaveValue("auto");
    await screen.findByText("高质量本地组件已就绪 · 1");
    expect(mocks.runtimeStatus).toHaveBeenCalledWith("quality");
    await user.selectOptions(screen.getByRole("combobox", { name: "AI 处理设备" }), "cuda");
    await user.click(screen.getByRole("button", { name: "开始连续视频深度" }));
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "quality", device: "cuda" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新 AI 状态" })).toBeEnabled());
    await user.selectOptions(screen.getByRole("combobox", { name: "处理引擎" }), "lite");
    expect(screen.getByRole("combobox", { name: "AI 处理设备" })).toHaveValue("auto");
    expect(screen.queryByRole("option", { name: "NVIDIA GPU" })).not.toBeInTheDocument();
  });

  it("does not reuse a late availability response after changing engines twice", async () => {
    let resolveQuality!: (status: typeof runtime) => void;
    let resolveLite!: (status: typeof runtime) => void;
    mocks.runtimeStatus
      .mockResolvedValueOnce(runtime)
      .mockReturnValueOnce(
        new Promise<typeof runtime>((resolve) => {
          resolveQuality = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<typeof runtime>((resolve) => {
          resolveLite = resolve;
        }),
      );
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("轻量本地组件已就绪 · 1");
    await user.selectOptions(screen.getByRole("combobox", { name: "处理引擎" }), "quality");
    expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "处理引擎" }), "lite");
    expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeDisabled();
    act(() => {
      resolveQuality(runtime);
    });
    expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeDisabled();
    act(() => {
      resolveLite(runtime);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeEnabled(),
    );
  });

  it("checks the recorded engine for retry rather than substituting the currently selected engine", async () => {
    mocks.list.mockResolvedValue([{ ...completedJob, status: "paused", outputs: [] }]);
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("轻量本地组件已就绪 · 1");
    mocks.runtimeStatus.mockResolvedValueOnce({
      ...runtime,
      ready: false,
      error: "高质量离线包未安装",
    });
    await user.click(await screen.findByRole("button", { name: "重新处理选区" }));
    expect(mocks.runtimeStatus).toHaveBeenLastCalledWith("quality");
    expect(await screen.findByText("高质量离线包未安装")).toBeInTheDocument();
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "处理引擎" })).toHaveValue("lite");
  });

  it("does not abandon the initial readiness check when the import picker is cancelled", async () => {
    let resolveRuntime!: (status: typeof runtime) => void;
    mocks.runtimeStatus.mockReturnValue(
      new Promise<typeof runtime>((resolve) => {
        resolveRuntime = resolve;
      }),
    );
    mocks.open.mockResolvedValue(null);
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "导入轻量本地离线包" }));
    expect(mocks.importRuntime).not.toHaveBeenCalled();
    act(() => {
      resolveRuntime(runtime);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始连续视频深度" })).toBeEnabled(),
    );
  });
});
