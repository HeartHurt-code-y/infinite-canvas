import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiMediaClient } from "./aiMedia";

const invoke = vi.hoisted(() => vi.fn());
const desktop = vi.hoisted(() => vi.fn(() => true));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./backend", () => ({ isDesktopRuntime: desktop }));

const source = {
  kind: "local_result" as const,
  generationTaskId: "original-task",
  resultIndex: 1,
  mediaType: "video" as const,
};
const output = {
  resultIndex: 0,
  role: "vocals",
  kind: "audio",
  path: "C:/jobs/ai/vocals.wav",
  name: "第01集_人声",
  mimeType: "audio/wav",
  durationSeconds: 6,
};
const job = {
  jobId: "ai-1",
  source,
  sourceIdentity: "sha256",
  name: "第01集",
  operation: "audio_separation",
  startSeconds: 2,
  endSeconds: 8,
  audioStreamIndex: 2,
  depthMaxSide: 480,
  device: "auto",
  status: "completed",
  progress: 100,
  outputs: [
    output,
    {
      ...output,
      resultIndex: 1,
      role: "accompaniment",
      path: "C:/jobs/ai/accompaniment.wav",
      name: "第01集_伴奏",
    },
    {
      ...output,
      resultIndex: 2,
      role: "manifest",
      kind: "data",
      path: "C:/jobs/ai/manifest.json",
      name: "第01集_信息",
      mimeType: "application/json",
    },
  ],
  createdAt: 1,
  updatedAt: 2,
};

describe("aiMediaClient", () => {
  beforeEach(() => {
    invoke.mockReset();
    desktop.mockReturnValue(true);
  });

  it("keeps the original generation identity, measured content and global audio stream", async () => {
    invoke.mockResolvedValue({ ...job, mode: "lite" });
    const command = {
      source,
      sourceIdentity: "sha256",
      name: "第01集",
      operation: "audio_separation" as const,
      startSeconds: 2,
      endSeconds: 8,
      audioStreamIndex: 2,
      depthMaxSide: 480 as const,
      device: "auto" as const,
    };
    expect((await aiMediaClient.start(command)).outputs[0]?.path).toBe(output.path);
    expect(invoke).toHaveBeenCalledWith("start_ai_media_job", {
      command: { ...command, mode: "lite" },
    });
  });

  it("blocks ambiguous output identities and incorrectly typed artifacts", async () => {
    invoke.mockResolvedValue({
      ...job,
      outputs: [output, { ...output, path: "C:/jobs/other.wav" }],
    });
    await expect(aiMediaClient.get("ai-1")).rejects.toThrow("序号重复");
    invoke.mockResolvedValue({
      ...job,
      outputs: [{ ...output, role: "depth_data", kind: "video" }],
    });
    await expect(aiMediaClient.get("ai-1")).rejects.toThrow("类型不匹配");
    invoke.mockResolvedValue({ ...job, progress: 101 });
    await expect(aiMediaClient.get("ai-1")).rejects.toThrow();
  });

  it("keeps nullable native recovery fields without claiming completion", async () => {
    invoke.mockResolvedValue({
      ...job,
      status: "paused",
      progress: null,
      outputs: [],
      error: null,
      message: null,
      actualDevice: null,
    });
    const restored = await aiMediaClient.get("ai-1");
    expect(restored.status).toBe("paused");
    expect(restored.outputs).toEqual([]);
    expect(restored.mode).toBe("quality");
  });

  it("rejects incomplete, mismatched or aliased completed outputs and an invalid native range", async () => {
    invoke.mockResolvedValue({ ...job, outputs: [output] });
    await expect(aiMediaClient.get("ai-1")).rejects.toThrow("不完整");
    invoke.mockResolvedValue({ ...job, operation: "video_depth" });
    await expect(aiMediaClient.get("ai-1")).rejects.toThrow("处理方式");
    invoke.mockResolvedValue({
      ...job,
      outputs: job.outputs.map((item, index) =>
        index === 1 ? { ...item, path: "c:\\JOBS\\AI\\VOCALS.wav" } : item,
      ),
    });
    await expect(aiMediaClient.get("ai-1")).rejects.toThrow("文件重复");
    invoke.mockResolvedValue({ ...job, endSeconds: 1 });
    await expect(aiMediaClient.get("ai-1")).rejects.toThrow("选区无效");
  });

  it("addresses renames and recovery with stable job and result indices", async () => {
    invoke.mockResolvedValue(job);
    await aiMediaClient.rename("ai-1", 0, "改名后人声.wav");
    await aiMediaClient.cancel("ai-1");
    await aiMediaClient.retry("ai-1");
    expect(invoke).toHaveBeenCalledWith("rename_ai_media_output", {
      jobId: "ai-1",
      resultIndex: 0,
      name: "改名后人声.wav",
    });
    expect(invoke).toHaveBeenCalledWith("cancel_ai_media_job", { jobId: "ai-1" });
    expect(invoke).toHaveBeenCalledWith("retry_ai_media_job", { jobId: "ai-1" });
    await expect(aiMediaClient.rename("ai-1", -1, "名称")).rejects.toThrow();
  });

  it("requires desktop, a video source and a valid finite selection before starting", async () => {
    const command = {
      source,
      name: "镜头",
      operation: "video_depth" as const,
      startSeconds: 3,
      endSeconds: 2,
      depthMaxSide: 480 as const,
      device: "auto" as const,
    };
    await expect(aiMediaClient.start(command)).rejects.toThrow("结束时间");
    await expect(aiMediaClient.start({ ...command, startSeconds: Number.NaN })).rejects.toThrow();
    await expect(
      aiMediaClient.start({ ...command, source: { ...source, mediaType: "audio" } }),
    ).rejects.toThrow();
    desktop.mockReturnValue(false);
    await expect(aiMediaClient.runtimeStatus()).rejects.toThrow("桌面应用");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates offline package status and rejects empty import paths", async () => {
    const runtime = {
      ready: false,
      videoDepthReady: false,
      audioSeparationReady: false,
      rootPath: null,
      version: null,
      error: "组件尚未安装",
    };
    invoke.mockResolvedValue(runtime);
    expect(await aiMediaClient.runtimeStatus()).toEqual(runtime);
    expect(await aiMediaClient.importRuntime(" C:/offline-package ")).toEqual(runtime);
    expect(invoke).toHaveBeenCalledWith("import_ai_media_runtime", {
      rootPath: "C:/offline-package",
      mode: "lite",
    });
    await expect(aiMediaClient.importRuntime("  ")).rejects.toThrow();
  });

  it("keeps runtime imports and availability scoped to the requested engine", async () => {
    const runtime = {
      ready: true,
      videoDepthReady: true,
      audioSeparationReady: true,
      mode: "quality",
    };
    invoke.mockResolvedValue(runtime);
    await aiMediaClient.runtimeStatus("quality");
    await aiMediaClient.importRuntime("C:/quality", "quality");
    expect(invoke).toHaveBeenCalledWith("get_ai_media_runtime_status", { mode: "quality" });
    expect(invoke).toHaveBeenCalledWith("import_ai_media_runtime", {
      rootPath: "C:/quality",
      mode: "quality",
    });
    await expect(aiMediaClient.runtimeStatus("lite")).rejects.toThrow("引擎不匹配");
    await expect(aiMediaClient.importRuntime("C:/quality", "lite")).rejects.toThrow("引擎不匹配");
  });

  it("records explicit quality requests and rejects unsupported engine/device combinations", async () => {
    const command = {
      source,
      name: "镜头",
      operation: "video_depth" as const,
      mode: "quality" as const,
      startSeconds: 1,
      endSeconds: 2,
      depthMaxSide: 480 as const,
      device: "cuda" as const,
    };
    invoke.mockResolvedValue({ ...job, mode: "quality" });
    await aiMediaClient.start(command);
    expect(invoke).toHaveBeenCalledWith("start_ai_media_job", { command });
    invoke.mockClear();
    await expect(aiMediaClient.start({ ...command, mode: "lite" })).rejects.toThrow("不兼容");
    await expect(aiMediaClient.start({ ...command, device: "directml" })).rejects.toThrow("不兼容");
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ ...job, mode: "lite", device: "directml" });
    expect((await aiMediaClient.start({ ...command, mode: "lite", device: "directml" })).mode).toBe(
      "lite",
    );
  });
});
