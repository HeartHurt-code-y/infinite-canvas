import * as v from "valibot";
import {
  videoComposerClient,
  videoFrameExtractionClient,
  type VideoCompositionJobRecord,
  type VideoFrameExtractionJobRecord,
} from "../../../lib/backend";
import type { AgentTool } from "./agentTypes";

/**
 * 剧本/分镜、视频抽帧与视频合成三类工作流节点的智能体工具宿主。
 * 与 video_download 工具同一分工：工具负责编排与轮询，宿主负责画布读写与落卡，
 * 本地文件路径等本机信息不进入工具返回值。
 */
export interface AgentWorkflowNodeHost {
  /** 整篇替换剧本或分镜节点的 Markdown 文档；其他节点抛错。 */
  setDocument(nodeKey: string, markdown: string): void;
  /** 显式写入抽帧秒数；由工具在 mutate 内调用，画布签名随之更新。 */
  setExtractorTimestamps(nodeKey: string, timestamps: readonly number[]): void;
  /** 抽帧来源与最终生效秒数；无可连线视频或未配置秒数时抛出人话原因。 */
  extractionSource(nodeKey: string): { videoPath: string; timestamps: readonly number[] };
  /** 抽帧完成落卡：每帧一张图片产物并连到该节点；返回产物 key 供模型引用。 */
  attachFrames(
    job: VideoFrameExtractionJobRecord,
    nodeKey: string,
  ): Promise<{ outputNodeKeys: readonly string[] }>;
  /** 按节点保存的顺序解析可交给 FFmpeg 的合成输入；不足两段或来源缺失时抛错。 */
  compositionInputs(nodeKey: string): {
    inputs: readonly { key: string; name: string; source: string }[];
    outputName: string;
  };
  /** 合成完成落一张视频产物卡；节点已被删除时 outputNodeKey 为 null（成片文件仍保留）。 */
  attachComposition(
    job: VideoCompositionJobRecord,
    nodeKey: string,
  ): Promise<{ outputNodeKey: string | null }>;
}

const key = v.pipe(v.string(), v.minLength(1), v.maxLength(180));
const documentSchema = v.strictObject({
  nodeKey: key,
  text: v.pipe(v.string(), v.maxLength(50_000)),
});
const extractSchema = v.strictObject({
  nodeKey: key,
  timestamps: v.optional(
    v.pipe(
      v.array(v.pipe(v.number(), v.finite(), v.minValue(0.1), v.maxValue(86_400))),
      v.minLength(1),
      v.maxLength(50),
    ),
  ),
});
const composeSchema = v.strictObject({ nodeKey: key });

const inputSchemas = {
  setDocument: {
    type: "object",
    properties: {
      nodeKey: { type: "string", minLength: 1, maxLength: 180 },
      text: { type: "string", maxLength: 50_000 },
    },
    required: ["nodeKey", "text"],
    additionalProperties: false,
  },
  extract: {
    type: "object",
    properties: {
      nodeKey: { type: "string", minLength: 1, maxLength: 180 },
      timestamps: {
        type: "array",
        items: { type: "number", minimum: 0.1, maximum: 86_400 },
        minItems: 1,
        maxItems: 50,
      },
    },
    required: ["nodeKey"],
    additionalProperties: false,
  },
  compose: {
    type: "object",
    properties: { nodeKey: { type: "string", minLength: 1, maxLength: 180 } },
    required: ["nodeKey"],
    additionalProperties: false,
  },
} as const;

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new DOMException("任务已取消", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** 同一节点的本机任务在本会话内互斥，避免计划重放时向同一节点重复提交。 */
const runningNodes = new Set<string>();

function isBusy(nodeKey: string, message: string): void {
  if (runningNodes.has(nodeKey)) throw new Error(message);
}

/** 抽帧/合成共同的处理中状态；其余状态视为终态交给调用方解释。 */
const isPendingStatus = (status: string) =>
  status === "preparing_engine" || status === "processing" || status === "paused";

export function createAgentWorkflowNodeTools(host: AgentWorkflowNodeHost): AgentTool[] {
  return [
    {
      name: "canvas.set_document",
      title: "写入剧本或分镜文档",
      description:
        "整篇替换剧本或分镜节点的 Markdown 文档；其他节点没有文档。先在回复里写好完整内容，再调用本工具落进节点；节点上的原文档会被替换且不保留。",
      effect: "write",
      inputSchema: inputSchemas.setDocument,
      validate(args) {
        v.parse(documentSchema, args);
      },
      execute(args, context) {
        const value = v.parse(documentSchema, args);
        const nodeKey = context.resolveNodeKey(value.nodeKey);
        context.mutate(() => host.setDocument(nodeKey, value.text));
        return Promise.resolve({
          nodeKey,
          updated: true,
          characters: value.text.length,
        });
      },
    },
    {
      name: "frame_extract.run",
      title: "运行视频抽帧",
      description:
        "把连线到抽帧节点的视频按指定秒数抽取关键帧图片，逐张落入画布并连到该节点。timestamps 可选：不填用节点上已配置的秒数。本机 FFmpeg 处理，不调用生成模型、不产生模型费用；抽帧前需先用 canvas.connect 连接视频素材或视频产物。",
      effect: "render",
      effectHint: "使用本机 FFmpeg 抽帧，不调用生成模型。",
      inputSchema: inputSchemas.extract,
      validate(args) {
        v.parse(extractSchema, args);
      },
      async execute(args, context) {
        const value = v.parse(extractSchema, args);
        const nodeKey = context.resolveNodeKey(value.nodeKey);
        if (value.timestamps)
          context.mutate(() => host.setExtractorTimestamps(nodeKey, value.timestamps!));
        const source = host.extractionSource(nodeKey);
        context.assertCurrent();
        isBusy(nodeKey, "这个抽帧节点已在处理中，请等待完成后再试。");
        runningNodes.add(nodeKey);
        let jobId: string | null = null;
        let pending = false;
        try {
          context.report("正在提交抽帧任务…");
          let record = await videoFrameExtractionClient.startExtraction(
            source.videoPath,
            source.timestamps,
          );
          jobId = record.jobId;
          context.assertCurrent();
          pending = true;
          while (isPendingStatus(record.status)) {
            context.report(
              record.status === "preparing_engine"
                ? "正在准备 FFmpeg 引擎…"
                : record.status === "paused"
                  ? "抽帧任务排队中，等待引擎空闲…"
                  : `正在抽帧（${record.progress != null ? `${Math.round(record.progress)}%` : "进度未知"}）`,
            );
            await waitForPoll(context.signal);
            context.assertCurrent();
            record = await videoFrameExtractionClient.getJob(record.jobId);
            context.assertCurrent();
          }
          pending = false;
          if (record.status === "cancelled" || context.signal.aborted)
            throw new Error("抽帧已取消。");
          if (record.status !== "completed")
            throw new Error(
              record.error ?? "视频抽帧失败；请确认连线的是可读取的视频文件后重试。",
            );
          const attached = await host.attachFrames(record, nodeKey);
          context.report("抽帧完成，帧图片已放入画布。");
          return {
            nodeKey,
            jobId: record.jobId,
            frameCount: record.frames.length,
            timestamps: [...source.timestamps],
            outputNodeKeys: attached.outputNodeKeys,
          };
        } catch (error: unknown) {
          if (jobId && (context.signal.aborted || pending)) {
            try {
              await videoFrameExtractionClient.cancelJob(jobId);
            } catch {
              context.report("停止抽帧任务失败，可在抽帧节点重试取消。");
            }
          }
          throw error;
        } finally {
          runningNodes.delete(nodeKey);
        }
      },
    },
    {
      name: "video_compose.run",
      title: "合成视频",
      description:
        "把连线到视频合成节点的视频按节点上的顺序合成为一个成片，完成后落入画布。需要至少两段视频且都已保存为本地文件或可访问地址；还在生成中的视频要先完成。本机 FFmpeg 处理，不调用生成模型、不产生模型费用。",
      effect: "render",
      effectHint: "使用本机 FFmpeg 合成视频，不调用生成模型。",
      inputSchema: inputSchemas.compose,
      validate(args) {
        v.parse(composeSchema, args);
      },
      async execute(args, context) {
        const value = v.parse(composeSchema, args);
        const nodeKey = context.resolveNodeKey(value.nodeKey);
        const resolved = host.compositionInputs(nodeKey);
        context.assertCurrent();
        isBusy(nodeKey, "这个合成节点已在处理中，请等待完成后再试。");
        runningNodes.add(nodeKey);
        let jobId: string | null = null;
        let pending = false;
        try {
          context.report(`正在提交合成任务（${resolved.inputs.length} 段视频）…`);
          let record = await videoComposerClient.startComposition(
            resolved.inputs,
            resolved.outputName,
          );
          jobId = record.jobId;
          context.assertCurrent();
          pending = true;
          while (record.status === "preparing_engine" || record.status === "processing") {
            context.report(
              record.status === "preparing_engine"
                ? "正在准备 FFmpeg 引擎…"
                : `正在合成视频（${record.progress != null ? `${Math.round(record.progress)}%` : "进度未知"}）`,
            );
            await waitForPoll(context.signal);
            context.assertCurrent();
            record = await videoComposerClient.getJob(record.jobId);
            context.assertCurrent();
          }
          pending = false;
          if (record.status === "cancelled" || context.signal.aborted)
            throw new Error("视频合成已取消。");
          if (record.status !== "completed" || record.finalPath == null)
            throw new Error(record.error ?? "视频合成失败；请检查上游视频文件后重试。");
          const attached = await host.attachComposition(record, nodeKey);
          context.report("视频合成完成，成片已放入画布。");
          return {
            nodeKey,
            jobId: record.jobId,
            inputCount: resolved.inputs.length,
            fileName: record.fileName,
            durationSeconds: record.durationSeconds ?? null,
            outputNodeKey: attached.outputNodeKey,
          };
        } catch (error: unknown) {
          if (jobId && (context.signal.aborted || pending)) {
            try {
              await videoComposerClient.cancelJob(jobId);
            } catch {
              context.report("停止合成任务失败，可在合成节点重试取消。");
            }
          }
          throw error;
        } finally {
          runningNodes.delete(nodeKey);
        }
      },
    },
  ];
}
