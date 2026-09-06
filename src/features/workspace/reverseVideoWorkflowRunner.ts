import {
  validateWorkflowMaterials,
  validateWorkflowMaterialsResume,
  withWorkflowMaterials,
  workflowMaterialsSignature,
} from "./workflowMaterials";
import {
  promptNodeClient,
  toMediaSrc,
  videoDownloaderClient,
  type PromptNodeClient,
  type TextSkillMode,
  type VideoDownloadJobRecord,
  type VideoDownloaderClient,
} from "../../lib/backend";
import { reverseVideoClient, type ReverseVideoClient } from "../../lib/reverseVideo";
import type { buildVideoContactSheets } from "../../lib/videoFrameSampler";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { sameWorkflowSignature, stableJsonSignature } from "../../lib/workflowSignatures";
import type {
  KnowledgeVideoWorkflowRunRequest,
  KnowledgeVideoWorkflowRunner,
} from "./knowledgeVideoWorkflowRunner";
import {
  CANVAS_ID,
  createKnowledgeVideoWorkflowConfig,
  isTextGenerationModel,
  type KnowledgeVideoWorkflowCheckpoint,
} from "./workspaceModel";
import {
  createReverseVideoCheckpoint,
  REVERSE_VIDEO_CONTINUITY,
  REVERSE_VIDEO_DIMENSIONS,
  reverseVideoDeliveryMarkdown,
  reverseVideoInputReady,
  reverseVideoPromptText,
  reverseVideoSourceUrl,
  type ReverseVideoAnalysis,
  type ReverseVideoBeat,
  type ReverseVideoReview,
  type ReverseVideoWorkflowCheckpoint,
} from "./reverseVideoWorkflowModel";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("反推结果必须是 JSON 对象。");
  return value as Record<string, unknown>;
}

function json(raw: string): Record<string, unknown> {
  return object(
    JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    ) as unknown,
  );
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 60_000)
    throw new Error(`${label} 必须是有效且完整的文本。`);
  return value;
}

function texts(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum)
    throw new Error(`${label} 必须包含 1～${maximum} 项。`);
  return value.map((entry) => text(entry, label));
}

function stringRecord<K extends string>(
  value: unknown,
  keys: readonly K[],
): Readonly<Record<K, string>> {
  const data = object(value);
  return Object.fromEntries(keys.map((key) => [key, text(data[key], key)])) as Record<K, string>;
}

function beats(
  value: unknown,
  label: string,
  start: number,
  end: number,
): readonly ReverseVideoBeat[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    throw new Error(`${label} 必须按实际动作节拍拆分，不能留空。`);
  const parsed = value.map((entry) => {
    const data = object(entry);
    const from = data["start"],
      to = data["end"];
    if (
      typeof from !== "number" ||
      typeof to !== "number" ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < start - 0.25 ||
      to > end + 0.25 ||
      to <= from
    )
      throw new Error(`${label} 起止时间必须位于实际视频范围内。`);
    return {
      start: from,
      end: to,
      action: text(data["action"], `${label}.action`),
      camera: text(data["camera"], `${label}.camera`),
      audio: text(data["audio"], `${label}.audio`),
      evidence: text(data["evidence"], `${label}.evidence`),
    };
  });
  let cursor = start;
  for (const beat of parsed) {
    if (Math.abs(beat.start - cursor) > 0.35)
      throw new Error(
        `${label} 必须按顺序覆盖 ${start.toFixed(1)}—${end.toFixed(1)} 秒，不能漏掉动作或重复时间段。`,
      );
    cursor = beat.end;
  }
  if (Math.abs(cursor - end) > 0.25) throw new Error(`${label} 必须覆盖最后一秒的实际收尾动作。`);
  return parsed;
}

function requireSelfContainedOutput(data: Record<string, unknown>): void {
  if (/https?:\/\/|www\.|!?\[[^\]]*\]\([^)]*\)|<a\b/i.test(JSON.stringify(data)))
    throw new Error(
      "反推交付必须是完整的本地可用方案，不能包含网站链接或跳转操作；视频下载、查看与交付由项目功能完成。",
    );
}

export function parseReverseVideoAnalysis(raw: string, duration: number): ReverseVideoAnalysis {
  const data = json(raw);
  requireSelfContainedOutput(data);
  if (data["schemaVersion"] !== "reverse-video-analysis.v1")
    throw new Error("反推结果版本必须为 reverse-video-analysis.v1。");
  const ending = object(data["ending"]);
  const routes = data["remixes"];
  if (!Array.isArray(routes) || routes.length !== 3)
    throw new Error("必须分别提供换皮、换视角、换叙事三条二创路线。");
  const remixes = routes.map((entry): ReverseVideoAnalysis["remixes"][number] => {
    const route = object(entry);
    const kind = route["route"];
    if (kind !== "skin" && kind !== "viewpoint" && kind !== "narrative")
      throw new Error("二创路线必须使用 skin、viewpoint、narrative。");
    return {
      route: kind,
      title: text(route["title"], "remixes.title"),
      retained: text(route["retained"], "remixes.retained"),
      replaced: text(route["replaced"], "remixes.replaced"),
      prompt: text(route["prompt"], "remixes.prompt"),
      expectedEffect: text(route["expectedEffect"], "remixes.expectedEffect"),
      risk: text(route["risk"], "remixes.risk"),
    };
  });
  if (new Set(remixes.map((route) => route.route)).size !== 3)
    throw new Error("三条二创路线不能重复。");
  return {
    schemaVersion: "reverse-video-analysis.v1",
    title: text(data["title"], "title"),
    summary: text(data["summary"], "summary"),
    dimensions: stringRecord(
      data["dimensions"],
      Object.keys(REVERSE_VIDEO_DIMENSIONS) as (keyof typeof REVERSE_VIDEO_DIMENSIONS)[],
    ),
    globalSettings: text(data["globalSettings"], "globalSettings"),
    scenes: text(data["scenes"], "scenes"),
    timeline: beats(data["timeline"], "全片分镜", 0, duration),
    ending: {
      beats: beats(ending["beats"], "结尾加密动作", Math.max(0, duration - 5), duration),
      finalFrame: text(ending["finalFrame"], "ending.finalFrame"),
      evidence: text(ending["evidence"], "ending.evidence"),
    },
    replicationPrompt: text(data["replicationPrompt"], "replicationPrompt"),
    viralDiagnosis: stringRecord(data["viralDiagnosis"], [
      "hook",
      "emotion",
      "memory",
      "replicable",
      "replace",
    ]),
    remixes,
    priority: text(data["priority"], "priority"),
    pitfalls: texts(data["pitfalls"], "pitfalls", 20),
    keywords: texts(data["keywords"], "keywords", 15),
    tags: texts(data["tags"], "tags", 15),
  };
}

export function parseReverseVideoReview(raw: string): ReverseVideoReview {
  const data = json(raw),
    result = data["result"];
  requireSelfContainedOutput(data);
  if (result !== "PASS" && result !== "REVISE" && result !== "NEEDS_DECISION")
    throw new Error("独立复核必须返回 PASS、REVISE 或 NEEDS_DECISION。");
  const report = text(data["report"], "report");
  if (result === "PASS") return { result, report };
  if (result === "REVISE")
    return {
      result,
      report,
      repairInstructions: text(data["repairInstructions"], "repairInstructions"),
    };
  return {
    result,
    report,
    question: text(data["question"], "question"),
    recommendation: text(data["recommendation"], "recommendation"),
    ...(data["repairInstructions"] == null
      ? {}
      : { repairInstructions: text(data["repairInstructions"], "repairInstructions") }),
  };
}

interface Dependencies {
  readonly promptClient: PromptNodeClient;
  readonly downloader: VideoDownloaderClient;
  readonly artifacts: ReverseVideoClient;
  readonly sample: typeof buildVideoContactSheets;
  readonly now: () => number;
  readonly createId: () => string;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const sleep: Dependencies["sleep"] = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("已暂停", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

function signature(request: KnowledgeVideoWorkflowRunRequest): string {
  return stableJsonSignature({
    brief: request.node.config.brief,
    sourceUrl: reverseVideoSourceUrl(request.node.config.reverseVideo?.sourceUrl ?? ""),
    localVideoPath: request.node.config.reverseVideo?.localVideoPath.trim() ?? "",
  });
}

function visionFailure(error: unknown): Error {
  const message = formatWorkflowError(error);
  const unavailable =
    /(?:image|vision|multimodal|图片|图像|视觉|多模态).{0,100}(?:not support|unsupported|not allowed|不支持|无法|不能)|(?:not support|unsupported|不支持).{0,100}(?:image|vision|multimodal|图片|图像|视觉|多模态)/i.test(
      message,
    );
  return new Error(
    unavailable
      ? `当前模型无法读取联系表，需要切换到支持读图的多模态模型后断点续跑。已下载视频和已抽取画面会保留，尚未确认的视觉结果不会当作交付物。\n${message}`
      : message,
  );
}

function isMissingDownload(error: unknown): boolean {
  let payload = error;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      return false;
    }
  }
  return Boolean(
    payload && typeof payload === "object" && "kind" in payload && payload.kind === "not_found",
  );
}

export function createReverseVideoWorkflowRunner(
  overrides: Partial<Dependencies> = {},
): KnowledgeVideoWorkflowRunner {
  const baseDependencies: Dependencies = {
    promptClient: promptNodeClient,
    downloader: videoDownloaderClient,
    artifacts: reverseVideoClient,
    sample: async (...args) => {
      const { buildVideoContactSheets } = await import("../../lib/videoFrameSampler");
      return buildVideoContactSheets(...args);
    },
    now: Date.now,
    createId: () => crypto.randomUUID(),
    sleep,
    ...overrides,
  };
  return {
    async run(request) {
      const dependencies = {
        ...baseDependencies,
        promptClient: withWorkflowMaterials(baseDependencies.promptClient, request.node.config),
      };
      const { node, signal } = request;
      let checkpoint = node.config.checkpoint;
      let lastProgress = 0;
      const commit = (change: Partial<KnowledgeVideoWorkflowCheckpoint>) => {
        checkpoint = { ...checkpoint, ...change, updatedAt: dependencies.now() };
        request.onCheckpoint(checkpoint);
      };
      const state = () => checkpoint.reverseVideo ?? createReverseVideoCheckpoint();
      const update = (change: Partial<ReverseVideoWorkflowCheckpoint>) =>
        commit({ reverseVideo: { ...state(), ...change } });
      const abort = () => {
        if (signal.aborted) throw new DOMException("已暂停", "AbortError");
      };
      const progress = (
        phase: KnowledgeVideoWorkflowCheckpoint["phase"],
        value: number,
        message: string,
        error: string | null = null,
      ) => {
        lastProgress = value;
        request.onProgress({ phase, progress: value, message, error });
      };
      const activate = (
        phase: "planning" | "generating" | "qc" | "composing",
        step: ReverseVideoWorkflowCheckpoint["step"],
        value: number,
        message: string,
      ) => {
        commit({ phase, lastActivePhase: phase, error: null, reverseVideo: { ...state(), step } });
        progress(phase, value, message);
      };
      try {
        abort();
        const options = node.config.reverseVideo;
        if (!options || !reverseVideoInputReady(node.config.brief, options))
          throw new Error(
            "请提供一条视频链接（支持完整分享文字）或选择一个本地视频，两种来源只选一种。",
          );
        if (
          !Number.isInteger(node.config.maxAutomaticRetries) ||
          node.config.maxAutomaticRetries < 0 ||
          node.config.maxAutomaticRetries > 10
        )
          throw new Error("自动修订次数必须为 0～10。");
        const startsNew = !request.resume || !checkpoint.runId || checkpoint.phase === "idle";
        validateWorkflowMaterials(node.config);
        if (!startsNew) validateWorkflowMaterialsResume(node.config, checkpoint);
        if (!startsNew && !sameWorkflowSignature(state().inputSignature, signature(request)))
          throw new Error("视频来源或补充要求已修改，请重新制作，避免把旧视频的分析用于新内容。");
        if (startsNew) {
          commit({
            ...createKnowledgeVideoWorkflowConfig(
              {
                prompt: node.config.models.text,
                image: node.config.models.image,
                video: node.config.models.video,
              },
              node.config.catalogResolved,
            ).checkpoint,
            runId: dependencies.createId(),
            materialsSignature: workflowMaterialsSignature(node.config),
            phase: "planning",
            lastActivePhase: "planning",
            documentsOnly: true,
            reverseVideo: { ...createReverseVideoCheckpoint(), inputSignature: signature(request) },
          });
        }
        if (checkpoint.phase === "done") {
          progress("done", 100, "原视频、反推提示词与案例已保留。");
          return checkpoint;
        }
        const sourceUrl = reverseVideoSourceUrl(options.sourceUrl) ?? "";
        if (!state().videoPath) {
          activate(
            "planning",
            "download",
            3,
            options.localVideoPath ? "正在准备本地视频…" : "正在通过项目下载器获取原视频…",
          );
          if (options.localVideoPath) update({ videoPath: options.localVideoPath });
          else {
            let job: VideoDownloadJobRecord | null = null;
            if (state().downloadJobId) {
              try {
                job = await dependencies.downloader.getJob(state().downloadJobId!);
              } catch (error) {
                // Download jobs are process-local. A typed not_found after restart is safe to restart;
                // network/query failures remain attached to the old identity instead.
                if (!request.resume || !isMissingDownload(error)) throw error;
                progress(
                  "planning",
                  4,
                  "旧下载任务在重启后已不存在，正在用项目下载器重新获取原视频…",
                );
              }
            }
            abort();
            // Only a confirmed failure/cancellation from a previous attempt permits another download.
            if (job && (job.status === "failed" || job.status === "cancelled")) {
              if (!request.resume)
                throw new Error(job.error ?? "视频下载已失败，请处理下载器设置后重试。");
              job = null;
            }
            if (!job) {
              let engine = await dependencies.downloader.getEngine();
              abort();
              if (engine.state !== "ready") {
                progress("planning", 4, "正在准备项目内置下载引擎…");
                engine = await dependencies.downloader.installEngine();
                abort();
              }
              if (engine.state !== "ready")
                throw new Error(
                  `项目下载引擎暂不可用，请在下载器设置中处理后重试。${engine.lastError ? `\n${engine.lastError}` : ""}`,
                );
              abort();
              job = await dependencies.downloader.startDownload(sourceUrl);
              // Retain the server identity even if pause arrived while creating the job.
              update({ downloadJobId: job.jobId });
            }
            while (true) {
              if (job.status === "completed") {
                if (!job.finalPath)
                  throw new Error("下载任务已完成但没有本地视频路径，请在项目下载器中检查原任务。");
                update({ videoPath: job.finalPath });
                abort();
                break;
              }
              abort();
              if (job.status === "failed" || job.status === "cancelled")
                throw new Error(
                  `项目下载器${job.status === "cancelled" ? "已取消" : "执行失败"}，可在下载器设置中处理登录状态或网络后重试。\n${job.error ?? "原任务身份已保留。"}`,
                );
              if (job.status !== "downloading" && job.status !== "preparing_engine")
                throw new Error("下载任务状态未确认；请稍后续跑查询原任务，当前不会重新下载。");
              progress(
                "planning",
                5 + Math.max(0, Math.min(100, job.progress ?? 0)) * 0.15,
                "项目下载器正在下载原视频…",
              );
              await dependencies.sleep(1200, signal);
              abort();
              job = await dependencies.downloader.getJob(job.jobId);
            }
          }
        }
        abort();
        if (!state().evidence) {
          activate("planning", "sampling", 22, "正在密集抽帧，并单独加密检查最后五秒…");
          const samples = await dependencies.sample(toMediaSrc(state().videoPath!), signal);
          abort();
          if (
            samples.sheets.length < 1 ||
            samples.sheets.length > 16 ||
            samples.overviewFrameCount < 1 ||
            samples.tailFrameCount < 1
          )
            throw new Error("实际视频联系表不完整，尚不能反推画面，请检查视频解码后重试。");
          const evidence = await dependencies.artifacts.saveEvidence({
            runId: checkpoint.runId!,
            videoPath: state().videoPath!,
            ...samples,
          });
          // Checkpoints retain local image paths, never contact-sheet Base64 bodies.
          update({ evidence });
          abort();
        }
        if (!state().learning) {
          const learning = await dependencies.artifacts.getLearning();
          update({ learning });
          abort();
        }
        const call = async <T>(
          mode: TextSkillMode,
          prompt: string,
          parse: (raw: string) => T,
        ): Promise<T> => {
          const model = request.providerCatalog
            .find(
              (entry) =>
                entry.provider.enabled && entry.provider.id === node.config.models.text.providerId,
            )
            ?.models.find(
              (entry) => entry.definitionId === node.config.models.text.modelDefinitionId,
            );
          if (!model || !isTextGenerationModel(model))
            throw new Error("请在节点中选择项目内支持读图的文本模型；已下载视频和联系表会保留。");
          let failure = "";
          for (let attempt = 0; attempt < 2; attempt++) {
            abort();
            let response;
            try {
              response = await dependencies.promptClient.run({
                canvasId: CANVAS_ID,
                sourceNodeId: node.key,
                providerConnectionId: node.config.models.text.providerId,
                modelDefinitionId: node.config.models.text.modelDefinitionId,
                mode,
                task: "generate",
                userPrompt: `${prompt}${failure ? `\n上一次 JSON 结构或时间覆盖不合格：${failure}。请修复完整输出结构，保持真实画面证据，不要让用户修 JSON。` : ""}`,
                visionImages: state().evidence!.sheets.map((sheet) => ({
                  target: {
                    kind: "local_file" as const,
                    path: sheet.localPath,
                    mediaType: "image" as const,
                  },
                  displayName: sheet.displayName,
                })),
              });
            } catch (error) {
              throw visionFailure(error);
            }
            abort();
            try {
              return parse(response.optimizedPrompt);
            } catch (error) {
              failure = formatWorkflowError(error);
            }
          }
          throw new Error(failure);
        };
        const base = () =>
          `补充要求：${node.config.brief || "自动完成真实视频反推与三条二创路线"}\n实际视频证据：${stableJsonSignature(state().evidence)}\n联系表按全片→结尾加密顺序传入，每格时间码为原视频秒数。必须读取实际图片，先顺序通看，再逐张核对最后五秒动作。不能凭链接、标题或过往案例编造本片内容。未传入音轨，不能声称听过原片；所有声音内容明确标为待听觉确认或建议配音。\n低权重历史经验：${stableJsonSignature(state().learning)}\n用户已确认决定：${stableJsonSignature(state().confirmedDecisions ?? [])}\n四段式完整输出：视频结构摘要、全片设定、分场设定、分镜生成稿；时间按动作节拍覆盖全片；结尾单独按动作覆盖最后五秒并写最终定格。十维提取与爆点五问完整，每条二创给可粘贴提示词、保留/替换/预期/风险，三条分别换皮、换视角、换叙事，至少改变两项维度。不要添加供应商、外链、作者推广或未经验证的播放量。提示词保留约束：${REVERSE_VIDEO_CONTINUITY}`;
        if (checkpoint.decision) {
          const resolution = request.decisionResolution?.trim();
          if (!resolution) {
            progress("awaiting_approval", 82, checkpoint.decision.question);
            return checkpoint;
          }
          update({
            confirmedDecisions: [
              ...(state().confirmedDecisions ?? []),
              `${checkpoint.decision.question}\n用户决定：${resolution}`,
            ],
            history: state().analysis
              ? [...state().history, { analysis: state().analysis!, review: state().review }]
              : state().history,
            analysis: null,
            review: null,
            repairCount: 0,
          });
          commit({ decision: null, error: null });
        }
        while (true) {
          abort();
          if (!state().analysis) {
            activate(
              "generating",
              "analysis",
              40,
              state().history.length
                ? "正在按复核意见与已确认决定修订反推…"
                : "正在读取实际画面、反推提示词并设计三条二创路线…",
            );
            const previous = state().history.at(-1);
            const analysis = await call(
              "reverse_video_analysis",
              `${base()}\n${previous ? `上一版与修订要求：${stableJsonSignature(previous)}\n请实际修改完整分析，不能直接把复核结果改为通过。` : "请输出完整反推分析 JSON。"}`,
              (raw) => parseReverseVideoAnalysis(raw, state().evidence!.duration),
            );
            update({ analysis, review: null });
            commit({
              manifest: stableJsonSignature(analysis),
              script: reverseVideoPromptText(analysis),
              storyboard: analysis.timeline
                .map((beat) => `${beat.start}—${beat.end}秒 ${beat.action}`)
                .join("\n"),
              planRevision: checkpoint.planRevision + 1,
            });
          }
          if (!state().review) {
            activate("qc", "review", 75, "正在独立核对结尾动作、时间覆盖与三条二创路线…");
            const review = await call(
              "reverse_video_review",
              `${base()}\n这是独立视觉复核，请重新读取本次真实联系表，对照完整分析：${stableJsonSignature(state().analysis)}\n检查十维、四阶段、人物与场景固定锚点、全片及结尾时间证据、摄影机、声音是否明确待听觉确认、三条不同二创和可粘贴提示词。只有关键证据冲突或用户必须决定的方向才 NEEDS_DECISION；可修错误用 REVISE，不可仅凭上一轮复核通过。`,
              parseReverseVideoReview,
            );
            update({ review });
          }
          const review = state().review!;
          if (review.result === "PASS") break;
          if (
            review.result === "NEEDS_DECISION" ||
            state().repairCount >= node.config.maxAutomaticRetries
          ) {
            const decision = {
              kind: "qc" as const,
              question: review.question ?? "反推已达到自动修订上限，是否继续按复核意见修订？",
              recommendation: review.recommendation ?? review.repairInstructions ?? review.report,
            };
            commit({ phase: "awaiting_approval", lastActivePhase: "qc", decision });
            progress("awaiting_approval", 82, decision.question);
            return checkpoint;
          }
          update({
            history: [...state().history, { analysis: state().analysis!, review }],
            analysis: null,
            review: null,
            repairCount: state().repairCount + 1,
          });
        }
        if (!state().delivery) {
          abort();
          activate("composing", "archive", 92, "正在保存原视频、MD / TXT 双文件并更新项目案例库…");
          const analysis = state().analysis!;
          const delivery = await dependencies.artifacts.deliver({
            runId: checkpoint.runId!,
            sourceUrl,
            videoPath: state().videoPath!,
            title: analysis.title,
            markdown: reverseVideoDeliveryMarkdown(checkpoint),
            promptText: reverseVideoPromptText(analysis),
            tags: analysis.tags,
            analysis: {
              scene: analysis.dimensions.scene,
              camera: analysis.dimensions.camera,
              color: analysis.dimensions.color,
              structure: analysis.summary,
              hook: analysis.dimensions.hook,
            },
            evidence: state().evidence!,
          });
          update({ delivery });
          abort();
        }
        commit({
          phase: "done",
          reverseVideo: { ...state(), step: "done" },
          finalPath: state().delivery!.videoPath,
          coverImagePath: state().evidence!.sheets[0]?.localPath ?? null,
          decision: null,
          error: null,
          approvedPlanRevision: checkpoint.planRevision,
        });
        progress("done", 100, "原视频、反推提示词 MD / TXT 与三条二创路线已交付，案例已入库。");
        return checkpoint;
      } catch (error) {
        const paused = signal.aborted || (error instanceof Error && error.name === "AbortError");
        const message = formatWorkflowError(error);
        commit({ phase: paused ? "paused" : "failed", error: paused ? null : message });
        progress(
          paused ? "paused" : "failed",
          lastProgress,
          paused ? "已暂停，续跑将复用下载任务、视频证据与已完成分析。" : "视频反推需要处理。",
          paused ? null : message,
        );
        return checkpoint;
      }
    },
  };
}
