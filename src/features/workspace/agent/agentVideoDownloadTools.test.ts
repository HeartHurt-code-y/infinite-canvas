import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDownloadJobRecord } from "../../../lib/backend";
import {
  agentDownloadTargetUrl,
  createAgentVideoDownloadTools,
  type AgentVideoDownloadHost,
} from "./agentVideoDownloadTools";
import type { AgentToolContext } from "./agentTypes";

function jobRecord(patch: Partial<VideoDownloadJobRecord> = {}): VideoDownloadJobRecord {
  return {
    jobId: "job-1",
    url: "https://v.example/x",
    status: "downloading",
    progress: 40,
    finalPath: null,
    fileName: null,
    qualityMode: null,
    qualityHint: null,
    watermarkRemoved: false,
    credentialSource: null,
    probeStatus: null,
    error: null,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function harness() {
  const startDownload = vi.fn(() => Promise.resolve(jobRecord()));
  const getJobs: VideoDownloadJobRecord[] = [];
  const getJob = vi.fn(() => Promise.resolve(getJobs.shift() ?? jobRecord()));
  const cancelJob = vi.fn(() => Promise.resolve(jobRecord({ status: "cancelled" })));
  const attachDownload = vi.fn(
    (
      job: VideoDownloadJobRecord,
      nodeKey: string | null,
    ): Promise<{ outputNodeKey: string; connected: boolean; connectionNote: string | null }> =>
      Promise.resolve({
        outputNodeKey: `output-${job.jobId}`,
        connected: nodeKey != null,
        connectionNote: null,
      }),
  );
  const probeVideo = vi.fn((path: string) =>
    Promise.resolve(
      path.includes("broken")
        ? { durationSeconds: null, width: null, height: null }
        : { durationSeconds: 42, width: 1080, height: 1920 },
    ),
  );
  const host: AgentVideoDownloadHost = {
    client: { startDownload, getJob, cancelJob },
    engineStatus: () =>
      Promise.resolve({
        state: "ready",
        cookiesInstalled: false,
        bilibiliLoggedIn: false,
        cookieBrowser: null,
      }),
    attachDownload,
    probeVideo,
  };
  const controller = new AbortController();
  const context: AgentToolContext = {
    signal: controller.signal,
    callId: "dl-1",
    report: vi.fn(),
    resolveNodeKey: (key) => (key === "$n1" ? "node-1" : key),
    assertCurrent: () => {},
    mutate: (change) => change(),
  };
  const tools = createAgentVideoDownloadTools(host);
  const start = tools.find((tool) => tool.name === "video_download.start")!;
  return {
    host,
    startDownload,
    getJob,
    getJobs,
    cancelJob,
    attachDownload,
    probeVideo,
    start,
    context,
    controller,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("智能体视频下载工具", () => {
  it("口令文本提取链接，完成后经宿主落卡；结果不携带本机路径", async () => {
    const view = harness();
    view.getJobs.push(
      jobRecord(),
      jobRecord({
        status: "completed",
        progress: 100,
        finalPath: "C:/Downloads/a.mp4",
        fileName: "a.mp4",
      }),
    );
    const run = view.start.execute(
      {
        url: "【分享】7.89 复制打开抖音，看看作品 https://v.example/x 复制此链接，打开抖音",
        nodeKey: "$n1",
      },
      view.context,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = (await run) as Record<string, unknown>;

    expect(view.startDownload).toHaveBeenCalledWith("https://v.example/x");
    expect(view.attachDownload).toHaveBeenCalledTimes(1);
    const [job, nodeKey] = view.attachDownload.mock.calls[0]!;
    expect(nodeKey).toBe("node-1");
    expect(job.status).toBe("completed");
    expect(view.probeVideo).toHaveBeenCalledWith("C:/Downloads/a.mp4");
    expect(JSON.stringify(result)).not.toContain("C:/Downloads");
    expect(result).toMatchObject({
      url: "https://v.example/x",
      fileName: "a.mp4",
      durationSeconds: 42,
      width: 1080,
      height: 1920,
      outputNodeKey: "output-job-1",
      connected: true,
    });
  });

  it("元数据探测失败不影响下载成果，时长按未知返回", async () => {
    const view = harness();
    view.getJobs.push(
      jobRecord({
        status: "completed",
        progress: 100,
        finalPath: "C:/Downloads/broken.mp4",
        fileName: "broken.mp4",
      }),
    );
    const run = view.start.execute({ url: "https://v.example/x" }, view.context);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(run).resolves.toMatchObject({
      fileName: "broken.mp4",
      durationSeconds: null,
      width: null,
      height: null,
    });
  });

  it("没有链接的参数在校验期就被拒绝，不进入执行", () => {
    const view = harness();
    expect(() => view.start.validate({ url: "帮我下载这个视频，谢谢" })).toThrow(
      "没有找到网页链接",
    );
    expect(agentDownloadTargetUrl("https://v.example/x。")).toBe("https://v.example/x");
    expect(agentDownloadTargetUrl("看看 https://v.example/x，")).toBe("https://v.example/x");
  });

  it("下载失败时保留后端原因并向用户说明", async () => {
    const view = harness();
    view.getJobs.push(
      jobRecord({ status: "failed", error: "该视频需要登录凭据，请先导入 Cookies" }),
    );
    const run = view.start.execute({ url: "https://v.example/x" }, view.context);
    const settled = expect(run).rejects.toThrow("该视频需要登录凭据");
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(view.attachDownload).not.toHaveBeenCalled();
  });

  it("停止下载会取消后端任务", async () => {
    const view = harness();
    view.getJobs.push(jobRecord());
    const run = view.start.execute({ url: "https://v.example/x" }, view.context);
    const settled = expect(run).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    view.controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(view.cancelJob).toHaveBeenCalledWith("job-1");
    expect(view.attachDownload).not.toHaveBeenCalled();
  });

  it("同一链接并发下载被互斥拒绝", async () => {
    const view = harness();
    view.getJobs.push(jobRecord());
    const first = view.start.execute({ url: "https://v.example/x" }, view.context);
    await expect(view.start.execute({ url: "https://v.example/x" }, view.context)).rejects.toThrow(
      "已在下载中",
    );
    expect(view.startDownload).toHaveBeenCalledTimes(1);
    const firstSettled = expect(first).rejects.toThrow();
    view.controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await firstSettled;
  });

  it("连线失败不吞掉下载成果，原因随结果返回", async () => {
    const view = harness();
    view.getJobs.push(
      jobRecord({
        status: "completed",
        progress: 100,
        finalPath: "C:/Downloads/a.mp4",
        fileName: "a.mp4",
      }),
    );
    view.attachDownload.mockResolvedValue({
      outputNodeKey: "output-1",
      connected: false,
      connectionNote: "目标节点不允许该连线",
    });
    const run = view.start.execute({ url: "https://v.example/x", nodeKey: "node-1" }, view.context);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(run).resolves.toMatchObject({
      outputNodeKey: "output-1",
      connected: false,
      connectionNote: "目标节点不允许该连线",
    });
  });
});
