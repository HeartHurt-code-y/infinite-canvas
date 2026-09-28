import {
  promptNodeClient,
  videoDownloaderClient,
  type PromptNodeClient,
  type VideoDownloadJobRecord,
  type VideoDownloaderClient,
} from "../../lib/backend";
import { reelbenchBackendClient } from "../../lib/reelbenchBackend";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { sameWorkflowSignature } from "../../lib/workflowSignatures";
import { downloadFailureSummary } from "./downloadFailureSummary";
import { isWorkflowExecutionPlanApproved, getWorkflowExecutionPlan } from "./workflowExecutionPlan";
import {
  validateWorkflowMaterials,
  validateWorkflowMaterialsResume,
  withWorkflowMaterials,
  workflowMaterialsSignature,
} from "./workflowMaterials";
import {
  createReelbenchCheckpoint,
  parseReelbenchAnnotationBatch,
  reelbenchDraftSignature,
  reelbenchInputReady,
  reelbenchInputSignature,
  reelbenchRegisterSubjects,
  reelbenchShotIsAnnotated,
  reelbenchSourceUrl,
  type ReelbenchShotDraft,
  type ReelbenchWorkflowCheckpoint,
} from "./reelbenchWorkflowModel";
import { writeReelbenchReports } from "./reelbenchReport";
import {
  CANVAS_ID,
  createKnowledgeVideoWorkflowConfig,
  isTextGenerationModel,
  type KnowledgeVideoWorkflowCheckpoint,
} from "./workspaceModel";
import type { KnowledgeVideoWorkflowRunner } from "./knowledgeVideoWorkflowRunner";

interface ReelbenchBackend {
  readonly analyze: typeof reelbenchBackendClient.analyze;
  readonly recut: typeof reelbenchBackendClient.recut;
  readonly validate: typeof reelbenchBackendClient.validate;
  readonly exportVideo: typeof reelbenchBackendClient.exportVideo;
}

interface Dependencies {
  readonly promptClient: PromptNodeClient;
  readonly downloader: VideoDownloaderClient;
  readonly backend: ReelbenchBackend;
  readonly writeReports: typeof writeReelbenchReports;
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

function batchPrompt(
  draft: ReelbenchShotDraft,
  ids: readonly string[],
  purpose: "remake" | "editing" | "inventory",
  language: "zh" | "en",
  brief: string,
  correction = "",
): string {
  const purposeLabel = {
    remake: "仿写参考：重点写可复现的画面、景别与运镜。",
    editing: "剪辑节奏：重点写切点后的叙事作用与节奏理由。",
    inventory: "投放素材盘点：重点写产品出镜、字卡和可核对卖点；不可推断的宣传事实留空。",
  }[purpose];
  const shots = ids
    .map((id) => draft.shots.find((shot) => shot.id === id)!)
    .map((shot) => ({
      id: shot.id,
      start: shot.start,
      end: shot.end,
      seconds: shot.seconds,
      motion: shot.motion,
      previous: shot.frame
        ? {
            size: shot.size,
            category: shot.category,
            camera: shot.camera,
            frame: shot.frame,
            transitionIn: shot.transitionIn,
            subjects: shot.subjects,
            onscreenText: shot.onscreenText,
            audio: shot.audio,
            rhythm: shot.rhythm,
            rhythmNote: shot.rhythmNote,
            note: shot.note,
          }
        : undefined,
    }));
  return (
    `只分析本批真实首尾联系表。图 A 为每镜起手约 15% 的画面，图 B 为收尾约 85% 的画面，格子按镜号顺序排列。\n` +
    `本批机器实测镜头：${JSON.stringify(shots)}\n用途：${purposeLabel}\n界面语言：${language}。用户重点：${brief || "无"}。\n` +
    "每个 ID 仅输出一次，按原顺序完整返回。切点、镜号、时间、时长、motion 均由本机测量，不得改写或虚构。" +
    "只对实际画面判断景别、类别、运镜、画面、可见文字和节奏。联系表没有音轨；除可见字幕外，audio 留空，不声称听到了台词。" +
    "不能加入来源作者、水印、外链、工具推荐或第三方跳转。只输出 shot-analysis.v1 JSON。" +
    (correction
      ? `\n上一次标注或质量门问题：${correction}。请修正实际画面判断，不修改机器字段。`
      : "")
  );
}

export function createReelbenchWorkflowRunner(
  overrides: Partial<Dependencies> = {},
): KnowledgeVideoWorkflowRunner {
  const base: Dependencies = {
    promptClient: promptNodeClient,
    downloader: videoDownloaderClient,
    backend: reelbenchBackendClient,
    writeReports: writeReelbenchReports,
    now: Date.now,
    createId: () => crypto.randomUUID(),
    sleep,
    ...overrides,
  };
  return {
    async run(request) {
      const dependencies = {
        ...base,
        promptClient: withWorkflowMaterials(base.promptClient, request.node.config),
      };
      const { node, signal } = request;
      let checkpoint = node.config.checkpoint;
      let lastProgress = 0;
      const commit = (change: Partial<KnowledgeVideoWorkflowCheckpoint>) => {
        checkpoint = { ...checkpoint, ...change, updatedAt: dependencies.now() };
        request.onCheckpoint(checkpoint);
      };
      const state = (): ReelbenchWorkflowCheckpoint =>
        checkpoint.reelbench ?? createReelbenchCheckpoint();
      const update = (change: Partial<ReelbenchWorkflowCheckpoint>) =>
        commit({ reelbench: { ...state(), ...change } });
      const abort = () => {
        if (signal.aborted) throw new DOMException("已暂停", "AbortError");
      };
      const progress = (
        phase: KnowledgeVideoWorkflowCheckpoint["phase"],
        percentage: number,
        message: string,
        error: string | null = null,
      ) => {
        lastProgress = percentage;
        request.onProgress({ phase, progress: percentage, message, error });
      };
      const guard = async () => {
        abort();
        const currentNode = { ...node, config: { ...node.config, checkpoint } };
        const plan = getWorkflowExecutionPlan(currentNode);
        if (!isWorkflowExecutionPlanApproved(plan, currentNode))
          throw new Error("拉片执行计划尚未确认或已失效，已阻止本机处理和模型请求。");
        await request.beforeSideEffect?.();
        abort();
        if (!isWorkflowExecutionPlanApproved(getWorkflowExecutionPlan(currentNode), currentNode))
          throw new Error("拉片执行计划已改变，请重新审核后继续。");
      };
      const activate = (
        phase: "planning" | "generating" | "qc" | "composing",
        step: ReelbenchWorkflowCheckpoint["step"],
        percentage: number,
        message: string,
      ) => {
        commit({ phase, lastActivePhase: phase, error: null, reelbench: { ...state(), step } });
        progress(phase, percentage, message);
      };

      try {
        abort();
        const options = node.config.reelbench;
        if (!options || !reelbenchInputReady(node.config.brief, options))
          throw new Error("请提供一条视频分享链接或选择一个本地视频，并检查切点设置。");
        const startsNew = !request.resume || !checkpoint.runId || checkpoint.phase === "idle";
        validateWorkflowMaterials(node.config);
        if (!startsNew) validateWorkflowMaterialsResume(node.config, checkpoint);
        if (
          !startsNew &&
          !sameWorkflowSignature(
            state().inputSignature ?? undefined,
            reelbenchInputSignature(node.config),
          )
        )
          throw new Error("原片、分析要求或模型已改变，请重新创建计划，旧拉片结果不能沿用。");
        if (startsNew) {
          const fresh = createKnowledgeVideoWorkflowConfig(
            {
              prompt: node.config.models.text,
              image: node.config.models.image,
              video: node.config.models.video,
            },
            node.config.catalogResolved,
          ).checkpoint;
          commit({
            ...fresh,
            ...((checkpoint.executionPlan ?? node.config.executionPlan)
              ? { executionPlan: checkpoint.executionPlan ?? node.config.executionPlan! }
              : {}),
            runId: dependencies.createId(),
            materialsSignature: workflowMaterialsSignature(node.config),
            phase: "planning",
            lastActivePhase: "planning",
            documentsOnly: !options.includeSyncVideo,
            reelbench: {
              ...createReelbenchCheckpoint(),
              inputSignature: reelbenchInputSignature(node.config),
            },
          });
        }
        const sourceUrl = reelbenchSourceUrl(options.sourceUrl) ?? "";
        if (!state().videoPath) {
          activate(
            "planning",
            "source",
            3,
            options.localVideoPath ? "正在读取本地原片…" : "正在下载原片…",
          );
          if (options.localVideoPath) update({ videoPath: options.localVideoPath });
          else {
            let job: VideoDownloadJobRecord | null = null;
            if (state().downloadJobId) {
              try {
                job = await dependencies.downloader.getJob(state().downloadJobId!);
              } catch (error) {
                if (!request.resume || !isMissingDownload(error)) throw error;
              }
            }
            if (job && (job.status === "failed" || job.status === "cancelled")) {
              if (!request.resume) throw new Error(downloadFailureSummary(job, "原片下载失败。"));
              job = null;
            }
            if (!job) {
              let engine = await dependencies.downloader.getEngine();
              abort();
              if (engine.state !== "ready") {
                await guard();
                engine = await dependencies.downloader.installEngine();
              }
              if (engine.state !== "ready")
                throw new Error(`项目下载引擎不可用。${engine.lastError ?? ""}`);
              await guard();
              job = await dependencies.downloader.startDownload(sourceUrl);
              update({ downloadJobId: job.jobId });
            }
            while (true) {
              abort();
              if (job.status === "completed") {
                if (!job.finalPath) throw new Error("下载完成但没有原片路径。");
                update({ videoPath: job.finalPath });
                break;
              }
              if (job.status === "failed" || job.status === "cancelled")
                throw new Error(downloadFailureSummary(job, "原片下载未完成。"));
              if (job.status !== "downloading" && job.status !== "preparing_engine")
                throw new Error("下载任务状态未确认，当前不会重新创建任务。");
              progress(
                "planning",
                5 + Math.min(100, job.progress ?? 0) * 0.15,
                "项目下载器正在保存原片…",
              );
              await dependencies.sleep(1200, signal);
              job = await dependencies.downloader.getJob(job.jobId);
            }
          }
        }
        abort();
        if (!state().draft) {
          activate("planning", "seed", 24, "正在实测切点、时长与逐镜首尾帧…");
          await guard();
          const draft = await dependencies.backend.analyze({
            videoPath: state().videoPath!,
            runId: checkpoint.runId!,
            sceneThreshold: options.sceneThreshold,
            minShotSeconds: options.minShotSeconds,
          });
          update({
            draft,
            pendingRecut: null,
            validation: null,
            validatedDraftSignature: null,
            approvedDraftSignature: null,
          });
        }
        if (state().pendingRecut) {
          activate("planning", "seed", 30, "正在按手工切点重新编号与抽帧…");
          const { splitCuts, mergeCuts } = state().pendingRecut!;
          await guard();
          const draft = await dependencies.backend.recut({
            draft: state().draft!,
            splitCuts: [...splitCuts],
            mergeCuts: [...mergeCuts],
          });
          update({
            draft,
            pendingRecut: null,
            validation: null,
            validatedDraftSignature: null,
            approvedDraftSignature: null,
          });
        }
        const model = request.providerCatalog
          .find(
            (entry) =>
              entry.provider.enabled && entry.provider.id === node.config.models.text.providerId,
          )
          ?.models.find(
            (entry) => entry.definitionId === node.config.models.text.modelDefinitionId,
          );
        if (!model || !isTextGenerationModel(model))
          throw new Error("请选择项目内支持读图的文本模型；已测量的切点和关键帧会保留。");
        const draft = state().draft!;
        for (const sheet of draft.sheets) {
          abort();
          const pendingIds = sheet.shotIds.filter((id) => {
            const shot = state().draft!.shots.find((entry) => entry.id === id);
            return shot && !reelbenchShotIsAnnotated(shot);
          });
          if (!pendingIds.length) continue;
          activate(
            "generating",
            "annotate",
            35 + (40 * (draft.shots.length - pendingIds.length)) / draft.shots.length,
            `正在对照首尾联系表标注 ${sheet.fromId}–${sheet.toId}…`,
          );
          let failure = "";
          let annotation: ReturnType<typeof parseReelbenchAnnotationBatch> | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            await guard();
            const result = await dependencies.promptClient.run({
              workflowRunId: checkpoint.runId!,
              canvasId: CANVAS_ID,
              sourceNodeId: node.key,
              providerConnectionId: node.config.models.text.providerId,
              modelDefinitionId: node.config.models.text.modelDefinitionId,
              mode: "reelbench_analysis",
              task: "generate",
              userPrompt: batchPrompt(
                state().draft!,
                pendingIds,
                options.purpose,
                options.language,
                node.config.brief,
                failure,
              ),
              visionImages: [sheet.frameAPath, sheet.frameBPath].map((path, index) => ({
                target: { kind: "local_file" as const, path, mediaType: "image" as const },
                displayName: `${sheet.fromId}–${sheet.toId} ${index === 0 ? "起手联系表" : "收尾联系表"}`,
              })),
            });
            abort();
            try {
              annotation = parseReelbenchAnnotationBatch(result.optimizedPrompt, pendingIds);
              break;
            } catch (error) {
              failure = formatWorkflowError(error);
            }
          }
          if (!annotation)
            throw new Error(`镜头 ${sheet.fromId}–${sheet.toId} 标注无效：${failure}`);
          const byId = new Map(annotation.map((item) => [item.id, item]));
          update({
            draft: reelbenchRegisterSubjects({
              ...state().draft!,
              shots: state().draft!.shots.map((shot) => {
                const result = byId.get(shot.id);
                return result
                  ? {
                      ...shot,
                      ...result,
                      subjects: [...result.subjects],
                      rhythm: result.rhythm ?? "",
                      rhythmNote: result.rhythmNote ?? "",
                    }
                  : shot;
              }),
            }),
            validation: null,
            validatedDraftSignature: null,
            approvedDraftSignature: null,
          });
        }
        if (!state().draft!.shots.every(reelbenchShotIsAnnotated))
          throw new Error("部分镜头尚未标注，联系表可能不完整，请检查后续跑。");
        const completedSignature = reelbenchDraftSignature(state().draft!);
        if (state().completedDraftSignature !== completedSignature)
          update({ completedDraftSignature: completedSignature });
        activate("qc", "validate", 82, "正在核验原片身份与镜头质量门…");
        await guard();
        const draftSignature = reelbenchDraftSignature(state().draft!);
        const trustedPreviousValidation =
          state().validatedDraftSignature === draftSignature && state().validation?.ok;
        // Native validation re-hashes the source video and checks the measured motion track.
        // This is required on every resume, even when a cached report or approval exists.
        const validation = await dependencies.backend.validate({ draft: state().draft! });
        update({
          validation,
          validatedDraftSignature: validation.ok ? draftSignature : null,
          approvedDraftSignature:
            validation.ok && trustedPreviousValidation ? state().approvedDraftSignature : null,
        });
        if (!state().validation!.ok) {
          commit({
            phase: "paused",
            lastActivePhase: "qc",
            error: null,
            reelbench: { ...state(), step: "review" },
          });
          progress("paused", 85, "质量门有待修项目；编辑镜头后重新检查。");
          return checkpoint;
        }
        if (state().approvedDraftSignature !== draftSignature) {
          commit({
            phase: "paused",
            lastActivePhase: "qc",
            error: null,
            reelbench: { ...state(), step: "review" },
          });
          progress("paused", 88, "全部镜头已通过质量门，请批量审核当前结果。 ");
          return checkpoint;
        }
        if (!state().reportHtmlPath) {
          activate("composing", "report", 92, "正在生成离线 JSON、Markdown 与交互报告…");
          await guard();
          if (
            !state().validation?.ok ||
            state().approvedDraftSignature !== reelbenchDraftSignature(state().draft!)
          )
            throw new Error("已审批的镜头版本与报告输入不一致，请重新检查并批准。");
          const paths = await dependencies.writeReports(
            state().draft!,
            state().validation!,
            options.language,
          );
          update(paths);
        }
        if (options.includeSyncVideo && !state().syncVideoPath) {
          activate("composing", "sync", 96, "正在用项目内 FFmpeg 合成分镜信息视频…");
          await guard();
          if (
            !state().validation?.ok ||
            state().approvedDraftSignature !== reelbenchDraftSignature(state().draft!)
          )
            throw new Error("已审批的镜头版本与视频输入不一致，请重新检查并批准。");
          const result = await dependencies.backend.exportVideo({
            draft: state().draft!,
            scale: options.syncScale,
            lang: options.language,
          });
          if (Math.abs(result.durationSeconds - state().draft!.meta.durationSeconds) > 0.2)
            throw new Error("同步视频实测时长与原片不一致，尚不能作为交付物。");
          update({ syncVideoPath: result.videoPath });
        }
        commit({
          phase: "done",
          lastActivePhase: null,
          error: null,
          decision: null,
          finalPath: state().syncVideoPath ?? state().reportHtmlPath,
          reelbench: { ...state(), step: "done" },
        });
        progress("done", 100, "镜头表、质量报告与所选同步视频均已保存。");
        return checkpoint;
      } catch (error) {
        const paused = signal.aborted || (error instanceof Error && error.name === "AbortError");
        const message = formatWorkflowError(error);
        commit({ phase: paused ? "paused" : "failed", error: paused ? null : message });
        progress(
          paused ? "paused" : "failed",
          lastProgress,
          paused ? "已暂停，续跑保留原片、切点和已完成的镜头标注。" : "拉片工作流需要处理。",
          paused ? null : message,
        );
        return checkpoint;
      }
    },
  };
}
