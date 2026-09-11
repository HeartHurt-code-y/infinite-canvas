import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BackendModule from "./backend";
import type { StagingJobRecord } from "./backend";
import {
  describeVideoEditFrameUploadProgress,
  resolveVideoEditFrameTarget,
  uploadVideoEditFrameToLibrary,
} from "./videoLocalEdit";

const startUpload = vi.fn<(_command: unknown) => Promise<string>>();
const getJob = vi.fn<(_jobId: string) => Promise<StagingJobRecord>>();
const logged: unknown[][] = [];

vi.mock("./backend", async (importOriginal) => {
  const actual = await importOriginal<typeof BackendModule>();
  return {
    ...actual,
    isDesktopRuntime: () => true,
    frontendLog: (...args: unknown[]) => {
      logged.push(args);
    },
    tosStagingClient: {
      ...actual.tosStagingClient,
      startUpload: (command: unknown) => startUpload(command),
      getJob: (jobId: string) => getJob(jobId),
    },
  };
});

function job(status: StagingJobRecord["status"], assetId: string | null = null): StagingJobRecord {
  return {
    id: "job-1",
    localPath: "/frames/annotation.png",
    purpose: "asset_import",
    mediaType: "image",
    objectKey: "obj.png",
    status,
    bytesTotal: 1,
    bytesUploaded: 1,
    assetId,
    importTarget: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const baseOptions = {
  path: "/frames/annotation.png",
  name: "原视频 · 2.000s 标注",
  canvasNodeKey: "annotation-1",
};

beforeEach(() => {
  startUpload.mockReset();
  getJob.mockReset();
  logged.length = 0;
});

describe("video edit frame library upload", () => {
  it("keeps the local file target when no asset library connection is configured", async () => {
    const result = await resolveVideoEditFrameTarget({
      ...baseOptions,
      providerConnectionId: null,
    });
    expect(startUpload).not.toHaveBeenCalled();
    expect(result.uploadedToLibrary).toBe(false);
    expect(result.target).toEqual({
      kind: "local_file",
      path: baseOptions.path,
      canvasNodeKey: baseOptions.canvasNodeKey,
      mediaType: "image",
    });
  });

  it("submits the frame as an asset identity once the library import completes", async () => {
    startUpload.mockResolvedValue("job-1");
    getJob
      .mockResolvedValueOnce(job("uploading"))
      .mockResolvedValueOnce(job("importing"))
      .mockResolvedValueOnce(job("active", "asset-42"));
    const result = await resolveVideoEditFrameTarget({
      ...baseOptions,
      providerConnectionId: "provider-1",
      pollIntervalMs: 0,
    });
    expect(startUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        localPath: baseOptions.path,
        purpose: "asset_import",
        mediaType: "image",
        import: { providerConnectionId: "provider-1", name: baseOptions.name, groupId: null },
      }),
    );
    expect(result.uploadedToLibrary).toBe(true);
    expect(result.target).toEqual({
      kind: "asset",
      providerConnectionId: "provider-1",
      assetId: "asset-42",
      canvasNodeKey: baseOptions.canvasNodeKey,
      mediaType: "image",
    });
  });

  it("reports progress stages while waiting for platform moderation", async () => {
    startUpload.mockResolvedValue("job-1");
    getJob
      .mockResolvedValueOnce(job("uploading"))
      .mockResolvedValueOnce(job("importing"))
      .mockResolvedValueOnce(job("active", "asset-42"));
    const labels: string[] = [];
    await uploadVideoEditFrameToLibrary({
      ...baseOptions,
      providerConnectionId: "provider-1",
      pollIntervalMs: 0,
      onProgress: (label) => labels.push(label),
    });
    expect(labels).toEqual([
      "正在提交标注帧上传…",
      "正在上传标注帧到对象存储…",
      "正在导入云端素材库…",
      "素材库导入完成",
    ]);
  });

  it("falls back to the local file when the import fails", async () => {
    startUpload.mockResolvedValue("job-1");
    getJob.mockResolvedValue(job("failed"));
    const result = await resolveVideoEditFrameTarget({
      ...baseOptions,
      providerConnectionId: "provider-1",
    });
    expect(result.uploadedToLibrary).toBe(false);
    expect(result.target.kind).toBe("local_file");
    expect(logged.some((entry) => entry[0] === "warn")).toBe(true);
  });

  it("falls back to the local file when the import times out", async () => {
    startUpload.mockResolvedValue("job-1");
    getJob.mockResolvedValue(job("importing"));
    const result = await resolveVideoEditFrameTarget({
      ...baseOptions,
      providerConnectionId: "provider-1",
      timeoutMs: 0,
      pollIntervalMs: 0,
    });
    expect(result.uploadedToLibrary).toBe(false);
    expect(result.target.kind).toBe("local_file");
  });

  it("falls back to the local file when the job is active without an asset id", async () => {
    startUpload.mockResolvedValue("job-1");
    getJob.mockResolvedValue(job("active", null));
    const result = await resolveVideoEditFrameTarget({
      ...baseOptions,
      providerConnectionId: "provider-1",
    });
    expect(result.uploadedToLibrary).toBe(false);
    expect(result.target.kind).toBe("local_file");
  });

  it("forwards the selected library group id when one is supplied", async () => {
    startUpload.mockResolvedValue("job-1");
    getJob.mockResolvedValue(job("active", "asset-42"));
    await uploadVideoEditFrameToLibrary({
      ...baseOptions,
      providerConnectionId: "provider-1",
      groupId: "128",
    });
    expect(startUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        import: { providerConnectionId: "provider-1", name: baseOptions.name, groupId: "128" },
      }),
    );
  });

  it("keeps waiting long enough for platform moderation instead of falling back at two minutes", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    startUpload.mockResolvedValue("job-1");
    getJob.mockImplementation(() => {
      // 每轮推进 10 秒：审核排队 150 秒后才放行（旧的两分钟上限会在这里放弃）。
      now += 10_000;
      return Promise.resolve(now >= 150_000 ? job("active", "asset-42") : job("importing"));
    });
    const asset = await uploadVideoEditFrameToLibrary({
      ...baseOptions,
      providerConnectionId: "provider-1",
      pollIntervalMs: 0,
    });
    expect(asset.assetId).toBe("asset-42");
    expect(now).toBeGreaterThan(120_000);
  });

  it("appends the elapsed wait to the progress label so a long moderation queue looks alive", async () => {
    expect(describeVideoEditFrameUploadProgress("正在导入云端素材库…", 1_200)).toBe(
      "正在导入云端素材库…",
    );
    expect(describeVideoEditFrameUploadProgress("正在导入云端素材库…", 42_000)).toBe(
      "正在导入云端素材库…（已等待 42 秒）",
    );
    expect(describeVideoEditFrameUploadProgress("正在导入云端素材库…", 125_000)).toBe(
      "正在导入云端素材库…（已等待 2 分 05 秒）",
    );
    // 停在同一状态时按间隔刷新已等待时长，用户能看出它还在等而不是卡死。
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    startUpload.mockResolvedValue("job-1");
    getJob.mockImplementation(() => {
      now += 20_000;
      return Promise.resolve(job("importing"));
    });
    const labels: string[] = [];
    await uploadVideoEditFrameToLibrary({
      ...baseOptions,
      providerConnectionId: "provider-1",
      timeoutMs: 80_000,
      pollIntervalMs: 0,
      onProgress: (label) => labels.push(label),
    }).catch(() => undefined);
    expect(labels.at(-1)).toBe("正在导入云端素材库…（已等待 1 分 20 秒）");
  });
});
