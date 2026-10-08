import { beforeEach, describe, expect, it, vi } from "vitest";
import { videoPreparationClient, validateVideoPreparationRange } from "./videoPreparation";

const invoke = vi.hoisted(() => vi.fn());
const desktop = vi.hoisted(() => vi.fn(() => true));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./backend", () => ({ isDesktopRuntime: desktop }));

const source = {
  kind: "local_base64_asset" as const,
  assetId: "stable-video",
  mediaType: "video" as const,
};
const job = {
  jobId: "prep-1",
  source,
  sourceIdentity: "source-sha256",
  name: "E001_SH012",
  operation: "extract_audio",
  startSeconds: 2,
  endSeconds: 8,
  audioStreamIndex: 2,
  format: "wav",
  status: "completed",
  progress: 100,
  createdAt: 1,
  updatedAt: 2,
  output: {
    kind: "audio",
    path: "C:/jobs/prep-1/audio.wav",
    name: "E001_SH012",
    mimeType: "audio/wav",
    durationSeconds: 6,
  },
};

describe("videoPreparationClient", () => {
  beforeEach(() => {
    invoke.mockReset();
    desktop.mockReturnValue(true);
  });

  it("submits measured stable identity and selected global stream index", async () => {
    invoke.mockResolvedValue(job);
    const command = {
      source,
      sourceIdentity: "source-sha256",
      name: "E001_SH012",
      operation: "extract_audio" as const,
      startSeconds: 2,
      endSeconds: 8,
      audioStreamIndex: 2,
      format: "wav" as const,
    };
    expect(await videoPreparationClient.start(command)).toEqual(job);
    expect(invoke).toHaveBeenCalledWith("start_video_preparation", { command });
  });

  it("rejects malformed external output metadata before it is used", async () => {
    invoke.mockResolvedValue({ ...job, output: { ...job.output, kind: "image" } });
    await expect(videoPreparationClient.get("prep-1")).rejects.toThrow();
    invoke.mockResolvedValue({ ...job, progress: 101 });
    await expect(videoPreparationClient.list()).rejects.toThrow();
  });

  it("preserves nullable optional Rust response fields", async () => {
    invoke.mockResolvedValue({
      ...job,
      output: null,
      progress: null,
      error: null,
      audioStreamIndex: null,
      status: "paused",
    });
    const recovered = await videoPreparationClient.get("prep-1");
    expect(recovered.status).toBe("paused");
    expect(recovered.output).toBeNull();
  });

  it("requires desktop, video identity and a positive range before invoking", async () => {
    const command = {
      source,
      sourceIdentity: "sha",
      name: "镜头",
      operation: "clip_video" as const,
      startSeconds: 8,
      endSeconds: 2,
    };
    await expect(videoPreparationClient.start(command)).rejects.toThrow("结束时间");
    await expect(videoPreparationClient.probe({ ...source, mediaType: "audio" })).rejects.toThrow();
    desktop.mockReturnValue(false);
    await expect(videoPreparationClient.list()).rejects.toThrow("桌面应用");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("addresses recovered jobs by job ID for retry and cancellation", async () => {
    invoke.mockResolvedValue({ ...job, status: "cancelled", output: null });
    await videoPreparationClient.cancel("prep-1");
    await videoPreparationClient.retry("prep-1");
    expect(invoke).toHaveBeenCalledWith("cancel_video_preparation_job", { jobId: "prep-1" });
    expect(invoke).toHaveBeenCalledWith("retry_video_preparation_job", { jobId: "prep-1" });
  });
  it("按稳定任务身份保存准备产物新名称，保持原路径", async () => {
    invoke.mockResolvedValue(job);
    const renamed = await videoPreparationClient.rename("prep-1", "第01集_对白.wav");
    expect(invoke).toHaveBeenCalledWith("rename_video_preparation_output", {
      jobId: "prep-1",
      name: "第01集_对白.wav",
    });
    expect(renamed.output?.path).toBe(job.output?.path);
  });
});

describe("validateVideoPreparationRange", () => {
  it.each([
    [Number.NaN, 2, "有效"],
    [-1, 2, "时长内"],
    [2, 11, "时长内"],
    [2, 2, "大于"],
    [3, 2, "大于"],
  ])("rejects %s to %s", (start, end, message) => {
    expect(validateVideoPreparationRange(Number(start), Number(end), 10)).toContain(
      String(message),
    );
  });
  it("accepts a full measured source", () => {
    expect(validateVideoPreparationRange(0, 10, 10)).toBeNull();
  });
});
