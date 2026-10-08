import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoPreparationJob, VideoPreparationProbe } from "../../lib/videoPreparation";
import type * as VideoPreparationModule from "../../lib/videoPreparation";
import { VideoPreparationDialog } from "./VideoPreparationDialog";
import { publishArtifactNameChange } from "./artifactNameSync";

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(() => true),
  prepare: vi.fn(),
  release: vi.fn(),
  probe: vi.fn(),
  start: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  export: vi.fn(),
}));
vi.mock("../../lib/backend", () => ({
  isDesktopRuntime: mocks.desktop,
  toMediaSrc: (path: string) => `asset://${path}`,
  formatRawBackendError: (reason: unknown) =>
    reason instanceof Error ? reason.message : String(reason),
}));
vi.mock("../../lib/videoLocalEdit", () => ({ prepareVideoEditSource: mocks.prepare }));
vi.mock("../../lib/videoPreparation", async (importOriginal) => ({
  ...(await importOriginal<typeof VideoPreparationModule>()),
  videoPreparationClient: {
    probe: mocks.probe,
    start: mocks.start,
    list: mocks.list,
    get: mocks.get,
    retry: mocks.retry,
    cancel: mocks.cancel,
  },
}));
vi.mock("./desktopActions", () => ({ exportArtifactToDesktop: mocks.export }));

const source = {
  name: "E001_SH012.mp4",
  target: {
    kind: "local_base64_asset" as const,
    assetId: "base64-stable",
    canvasNodeKey: "video-card",
    mediaType: "video" as const,
  },
};
const measured: VideoPreparationProbe = {
  durationSeconds: 15,
  width: 1920,
  height: 1080,
  fps: 25,
  sourceIdentity: "measured-content-sha256",
  audioStreams: [{ index: 2, codec: "aac", language: "chi", channels: 2, sampleRate: 48000 }],
};
const pausedJob: VideoPreparationJob = {
  jobId: "prep-restore",
  source: source.target,
  sourceIdentity: measured.sourceIdentity,
  name: "已保存镜头",
  operation: "clip_video",
  startSeconds: 1,
  endSeconds: 4,
  format: "wav",
  status: "paused",
  createdAt: 10,
  updatedAt: 20,
};
const completedJob: VideoPreparationJob = {
  ...pausedJob,
  status: "completed",
  updatedAt: 30,
  progress: 100,
  output: {
    kind: "audio",
    path: "C:/media/result.wav",
    name: "已保存音轨",
    mimeType: "audio/wav",
    durationSeconds: 3,
  },
};

function renderDialog() {
  const onClose = vi.fn();
  const onUseOutput = vi.fn<(output: unknown, job: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const view = render(
    <VideoPreparationDialog source={source} onClose={onClose} onUseOutput={onUseOutput} />,
  );
  return { ...view, onClose, onUseOutput };
}

describe("VideoPreparationDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.desktop.mockReturnValue(true);
    mocks.prepare.mockResolvedValue({ src: "asset://owned-preview", release: mocks.release });
    mocks.release.mockResolvedValue(undefined);
    mocks.probe.mockResolvedValue(measured);
    mocks.list.mockResolvedValue([]);
    mocks.start.mockResolvedValue({
      ...pausedJob,
      jobId: "new-prep",
      status: "processing",
      progress: 3,
      updatedAt: 21,
    });
    mocks.get.mockResolvedValue({
      ...pausedJob,
      status: "processing",
      progress: 30,
      updatedAt: 23,
    });
    mocks.retry.mockResolvedValue({
      ...pausedJob,
      status: "processing",
      progress: 10,
      updatedAt: 22,
    });
    mocks.cancel.mockResolvedValue({ ...pausedJob, status: "cancelled", updatedAt: 24 });
    mocks.export.mockResolvedValue("C:/delivery/已保存音轨.wav");
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  it("uses stable source and measured identity, sharing the timeline range with selected audio", async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByRole("button", { name: "准确裁切片段" })).toBeEnabled());
    fireEvent.change(screen.getByRole("slider", { name: "视频时间轴" }), {
      target: { value: "2.5" },
    });
    await user.click(screen.getByRole("button", { name: "当前时间设为开始" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "选区结束时间" }), {
      target: { value: "8" },
    });
    await user.selectOptions(screen.getByRole("combobox", { name: "处理方式" }), "extract_audio");
    await user.selectOptions(screen.getByRole("combobox", { name: "音频格式" }), "original");
    await user.click(screen.getByRole("button", { name: "提取音轨" }));
    expect(mocks.start).toHaveBeenCalledWith({
      source: source.target,
      sourceIdentity: measured.sourceIdentity,
      name: "E001_SH012",
      operation: "extract_audio",
      startSeconds: 2.5,
      endSeconds: 8,
      audioStreamIndex: 2,
      format: "original",
    });
    expect(mocks.prepare).toHaveBeenCalledWith(source.target, "");
  });

  it("disables audio extraction for silent sources and blocks invalid ranges", async () => {
    mocks.probe.mockResolvedValue({ ...measured, audioStreams: [] });
    renderDialog();
    expect(await screen.findByText("原视频没有音轨，仍可裁切或导出无声视频。")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "提取音轨" })).toBeDisabled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "选区开始时间" }), {
      target: { value: "15" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("结束时间必须大于开始时间");
    expect(screen.getByRole("button", { name: "准确裁切片段" })).toBeDisabled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("recovers a paused job and cancels the same job after retry", async () => {
    mocks.list.mockResolvedValue([pausedJob]);
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "继续任务" }));
    expect(mocks.retry).toHaveBeenCalledWith("prep-restore");
    await user.click(await screen.findByRole("button", { name: "取消任务" }));
    expect(mocks.cancel).toHaveBeenCalledWith("prep-restore");
    expect(await screen.findByRole("button", { name: "重试任务" })).toBeInTheDocument();
  });

  it("only adds completed output after explicit click and exports its actual extension", async () => {
    mocks.list.mockResolvedValue([completedJob]);
    const user = userEvent.setup();
    const { onUseOutput } = renderDialog();
    const add = await screen.findByRole("button", { name: "加入画布" });
    expect(onUseOutput).not.toHaveBeenCalled();
    await user.click(add);
    expect(onUseOutput).toHaveBeenCalledWith(completedJob.output, completedJob);
    expect(screen.getByRole("button", { name: "已加入画布" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "按名称导出" }));
    expect(mocks.export).toHaveBeenCalledWith("C:/media/result.wav", "已保存音轨.wav");
    expect(await screen.findByText("已导出到 C:/delivery/已保存音轨.wav")).toBeInTheDocument();
  });

  it("画布改名同步到已打开的准备窗口，导出使用新名", async () => {
    mocks.list.mockResolvedValue([completedJob]);
    renderDialog();
    const exportButton = await screen.findByRole("button", { name: "按名称导出" });
    await act(() =>
      publishArtifactNameChange({
        taskId: completedJob.jobId,
        finalPath: completedJob.output!.path,
        name: "第01集_对白_新版.wav",
      }),
    );
    fireEvent.click(exportButton);
    await waitFor(() =>
      expect(mocks.export).toHaveBeenCalledWith(completedJob.output!.path, "第01集_对白_新版.wav"),
    );
  });

  it("releases an owned preview on unmount and a late preview after unmount", async () => {
    const { unmount: unmountFirst } = renderDialog();
    await waitFor(() =>
      expect(screen.getByLabelText("原视频：E001_SH012.mp4")).toHaveAttribute(
        "src",
        "asset://owned-preview",
      ),
    );
    unmountFirst();
    expect(mocks.release).toHaveBeenCalledOnce();
    mocks.release.mockClear();
    let finish: ((result: { src: string; release: () => Promise<void> }) => void) | undefined;
    mocks.prepare.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { unmount: unmountSecond } = renderDialog();
    unmountSecond();
    finish?.({ src: "asset://late", release: mocks.release });
    await waitFor(() => expect(mocks.release).toHaveBeenCalledOnce());
  });

  it("shows native availability without submitting or reading in browser preview", () => {
    mocks.desktop.mockReturnValue(false);
    renderDialog();
    expect(screen.getByRole("status")).toHaveTextContent("桌面应用");
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
