import * as v from "valibot";
import type { VideoDownloadJobRecord } from "../../../lib/backend";
import { extractVideoUrls } from "../videoDownloadInputs";
import type { AgentTool } from "./agentTypes";

/** 智能体只消费下载客户端的这三个方法；引擎安装与 Cookies 管理留在下载节点。 */
export interface AgentVideoDownloadClient {
  startDownload(url: string): Promise<VideoDownloadJobRecord>;
  getJob(jobId: string): Promise<VideoDownloadJobRecord>;
  cancelJob(jobId: string): Promise<VideoDownloadJobRecord>;
}

/** 引擎摘要不含二进制路径等本机信息；本地路径永远不跨过模型接口。 */
export interface AgentVideoDownloadEngineSummary {
  readonly state: "not_installed" | "installing" | "ready" | "failed";
  readonly cookiesInstalled: boolean;
  readonly bilibiliLoggedIn: boolean;
  readonly cookieBrowser: string | null;
}

export interface AgentVideoDownloadHost {
  client: AgentVideoDownloadClient;
  engineStatus(): Promise<AgentVideoDownloadEngineSummary>;
  /** 完成后落一张 origin=download 的产物卡片；connectToNodeKey 为 null 时只落卡。
   *  连线失败不视为下载失败：卡片保留，原因经 connectionNote 带回给模型转述。 */
  attachDownload(
    job: VideoDownloadJobRecord,
    connectToNodeKey: string | null,
  ): Promise<{ outputNodeKey: string; connected: boolean; connectionNote: string | null }>;
  /** 探测已下载文件的媒体元数据；探测失败返回全 null，不影响下载成果。 */
  probeVideo(path: string): Promise<{
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
  }>;
}

const shareText = v.pipe(v.string(), v.minLength(1), v.maxLength(2000));
const argsSchema = v.strictObject({
  url: shareText,
  nodeKey: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(180))),
});
const inputSchema = {
  type: "object",
  properties: {
    url: { type: "string", minLength: 1, maxLength: 2000 },
    nodeKey: { type: "string", minLength: 1, maxLength: 180 },
  },
  required: ["url"],
  additionalProperties: false,
};

/** 与下载节点同一口径：口令文本里提取首个链接；没有链接的计划在校验期就被拒绝。 */
export function agentDownloadTargetUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/[，。；、！？）\]】}]+$/u, "");
  const [first] = extractVideoUrls(raw);
  if (!first) throw new Error("参数 url 里没有找到网页链接；请粘贴视频链接或完整的分享口令文本。");
  return first;
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new DOMException("下载已取消", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

const engineStateText: Record<AgentVideoDownloadEngineSummary["state"], string> = {
  not_installed: "下载引擎未安装；首次下载会自动准备，需要等待片刻。",
  installing: "下载引擎正在安装；请稍后再次发起下载。",
  ready: "下载引擎就绪。",
  failed: "下载引擎不可用；请打开「网络爆款视频下载」节点查看修复入口。",
};

/** 同一链接的智能体下载在本会话内互斥，避免重复落两张相同产物卡。 */
const downloading = new Set<string>();

export function createAgentVideoDownloadTools(host: AgentVideoDownloadHost): AgentTool[] {
  return [
    {
      name: "video_download.inspect",
      title: "查询下载引擎",
      effect: "read",
      description:
        "查询本机视频下载引擎与登录凭据状态。会员或登录可见的视频需要先在「网络爆款视频下载」节点导入凭据；公开视频无需凭据。",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      validate(args) {
        v.parse(v.strictObject({}), args);
      },
      async execute(_args, context) {
        context.signal.throwIfAborted();
        const status = await host.engineStatus();
        return {
          ...status,
          stateText: engineStateText[status.state],
          readyToDownload: status.state === "ready" || status.state === "not_installed",
        };
      },
    },
    {
      name: "video_download.start",
      title: "下载链接视频",
      effect: "download",
      description:
        "从任意视频分享链接下载原视频到本机，完成后作为素材卡片放入画布；nodeKey 可选，填入则把卡片连接到该节点（如爆款复刻的原视频输入）。url 可以是纯链接或整段分享口令文本，自动提取链接。下载不调用生成模型、不产生模型费用；会员视频需先在下载节点导入凭据。结果返回原视频的 durationSeconds（秒）与宽高，可据此用 canvas.set_parameters 把视频节点的 duration 参数设为相同时长。下载耗时随视频大小而定，可随时停止。",
      inputSchema,
      validate(args) {
        const parsed = v.parse(argsSchema, args);
        agentDownloadTargetUrl(parsed.url);
      },
      async execute(args, context) {
        context.signal.throwIfAborted();
        context.assertCurrent();
        const parsed = v.parse(argsSchema, args);
        const url = agentDownloadTargetUrl(parsed.url);
        const nodeKey = parsed.nodeKey ? context.resolveNodeKey(parsed.nodeKey) : null;
        if (downloading.has(url)) throw new Error("这个链接已在下载中，请等待完成或停止后再试。");
        downloading.add(url);
        let job: VideoDownloadJobRecord | null = null;
        try {
          context.report("正在提交下载…");
          job = await host.client.startDownload(url);
          context.assertCurrent();
          while (job.status === "preparing_engine" || job.status === "downloading") {
            context.report(
              job.status === "preparing_engine"
                ? "正在准备下载引擎…"
                : `正在下载视频（${job.progress != null ? `${Math.round(job.progress)}%` : "进度未知"}）`,
            );
            await waitForPoll(context.signal);
            context.assertCurrent();
            job = await host.client.getJob(job.jobId);
            context.assertCurrent();
          }
          if (job.status === "cancelled" || context.signal.aborted) throw new Error("下载已取消。");
          if (job.status !== "completed" || job.finalPath == null)
            throw new Error(
              job.error ?? "视频下载失败；请检查链接是否为可公开访问的视频页面，或稍后重试。",
            );
          const attached = await host.attachDownload(job, nodeKey);
          context.report("视频已下载并放入画布。");
          const media = await host.probeVideo(job.finalPath);
          return {
            url,
            jobId: job.jobId,
            fileName: job.fileName,
            durationSeconds: media.durationSeconds,
            width: media.width,
            height: media.height,
            watermarkRemoved: job.watermarkRemoved,
            credentialSource: job.credentialSource ?? null,
            outputNodeKey: attached.outputNodeKey,
            connected: attached.connected,
            connectionNote: attached.connectionNote,
          };
        } catch (error: unknown) {
          if (
            job &&
            (context.signal.aborted ||
              job.status === "preparing_engine" ||
              job.status === "downloading")
          ) {
            try {
              await host.client.cancelJob(job.jobId);
            } catch {
              context.report("停止下载任务失败，可在下载节点重试取消。");
            }
          }
          throw error;
        } finally {
          downloading.delete(url);
        }
      },
    },
  ];
}
