import {
  generationClient,
  promptNodeClient,
  type GenerationTaskClient,
  type GenerationTaskDetail,
  type OptimizeVideoPromptCommand,
  type PromptNodeClient,
  type StartGenerationCommand,
} from "../../lib/backend";
import {
  workflowHistoryClient,
  type WorkflowHistoryClient,
  type WorkflowHistoryDetail,
  type WorkflowHistoryEvent,
  type WorkflowHistoryKind,
  type WorkflowHistoryRecord,
} from "../../lib/workflowHistory";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { stableJsonSignature } from "../../lib/workflowSignatures";
import { validateWorkflowMaterialsResume, workflowMaterialsSignature } from "./workflowMaterials";
import { createAiFilmWorkflowRunner } from "./aiFilmWorkflowRunner";
import { createComicDramaWorkflowRunner } from "./comicDramaWorkflowRunner";
import { createCommerceWorkflowRunner } from "./commerceWorkflowRunner";
import {
  createKnowledgeVideoWorkflowRunner,
  type KnowledgeVideoWorkflowRunRequest,
  type KnowledgeVideoWorkflowRunner,
} from "./knowledgeVideoWorkflowRunner";
import { createRemotionWorkflowRunner } from "./remotionWorkflowRunner";
import { createXhsCoverWorkflowRunner } from "./xhsCoverWorkflowRunner";
import { createReverseVideoWorkflowRunner } from "./reverseVideoWorkflowRunner";
import {
  CANVAS_ID,
  type KnowledgeVideoWorkflowCheckpoint,
  type KnowledgeVideoWorkflowNodeData,
  type KnowledgeVideoWorkflowRunState,
} from "./workspaceModel";

interface RecordedClients {
  readonly promptClient: PromptNodeClient;
  readonly generationClient: GenerationTaskClient;
}
export interface RecordedWorkflowRunRequest extends KnowledgeVideoWorkflowRunRequest {
  /** Explicit migration of an existing canvas checkpoint into its first history record. */
  readonly newHistory?: boolean;
}
export interface RecordedWorkflowRunner {
  run(request: RecordedWorkflowRunRequest): Promise<KnowledgeVideoWorkflowCheckpoint>;
}
export interface RecordedWorkflowDependencies extends RecordedClients {
  readonly historyClient: Pick<WorkflowHistoryClient, "get" | "save">;
  readonly runnerFactory: (
    kind: WorkflowHistoryKind,
    clients: RecordedClients,
  ) => KnowledgeVideoWorkflowRunner;
  readonly now: () => number;
  readonly createId: () => string;
}

export function workflowKindForNode(node: KnowledgeVideoWorkflowNodeData): WorkflowHistoryKind {
  if (node.config.reverseVideo) return "reverseVideo";
  if (node.config.xhsCover) return "xhsCover";
  if (node.config.remotion) return "remotion";
  if (node.config.commerce) return "commerce";
  if (node.config.comicDrama) return "comicDrama";
  if (node.config.film) return "film";
  return "knowledge";
}

const TITLES: Record<WorkflowHistoryKind, string> = {
  knowledge: "知识视频",
  film: "影视制作",
  comicDrama: "漫剧制作",
  commerce: "带货创作",
  remotion: "动画制作",
  xhsCover: "小红书封面",
  reverseVideo: "短视频反推",
};

function defaultRunnerFactory(
  kind: WorkflowHistoryKind,
  clients: RecordedClients,
): KnowledgeVideoWorkflowRunner {
  switch (kind) {
    case "film":
      return createAiFilmWorkflowRunner(clients);
    case "comicDrama":
      return createComicDramaWorkflowRunner(clients);
    case "commerce":
      return createCommerceWorkflowRunner(clients);
    case "remotion":
      return createRemotionWorkflowRunner({ promptClient: clients.promptClient });
    case "xhsCover":
      return createXhsCoverWorkflowRunner(clients);
    case "reverseVideo":
      return createReverseVideoWorkflowRunner({ promptClient: clients.promptClient });
    case "knowledge":
      return createKnowledgeVideoWorkflowRunner(clients);
  }
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringsIn(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") result.add(value);
  else if (Array.isArray(value)) value.forEach((item: unknown) => stringsIn(item, result));
  else if (value && typeof value === "object")
    Object.values(value).forEach((item: unknown) => stringsIn(item, result));
  return result;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          item != null && !["workflowRunId", "canvasId", "sourceNodeId", "byteSize"].includes(key),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function commandKey(value: unknown, operation: "text" | "media"): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item["providerConnectionId"] !== "string" ||
    typeof item["modelDefinitionId"] !== "string"
  )
    return null;
  if (operation === "text") {
    if (typeof item["userPrompt"] !== "string" || typeof item["mode"] !== "string") return null;
    return JSON.stringify(
      canonical({
        provider: item["providerConnectionId"],
        model: item["modelDefinitionId"],
        mode: item["mode"],
        task: item["task"] ?? "optimize",
        prompt: item["userPrompt"],
        contextHistory: item["contextHistory"] ?? [],
        visionImages: item["visionImages"] ?? [],
        multimodalInputs: item["multimodalInputs"] ?? [],
      }),
    );
  }
  if (!Array.isArray(item["prompt"]) || typeof item["operation"] !== "string") return null;
  return JSON.stringify(
    canonical({
      provider: item["providerConnectionId"],
      model: item["modelDefinitionId"],
      operation: item["operation"],
      prompt: item["prompt"],
      parameters: item["parameters"] ?? {},
      explicitMedia: item["explicitMedia"] ?? [],
      generationCount: item["generationCount"] ?? 1,
    }),
  );
}

function modelSnapshots(
  request: KnowledgeVideoWorkflowRunRequest,
  kind: WorkflowHistoryKind,
): WorkflowHistoryRecord["models"] {
  const roles =
    kind === "remotion" ||
    kind === "reverseVideo" ||
    (kind === "xhsCover" && request.node.config.xhsCover?.deliverable === "prompt")
      ? (["text"] as const)
      : kind === "xhsCover"
        ? (["text", "image"] as const)
        : (["text", "image", "video"] as const);
  return roles.map((role) => {
    const selected = request.node.config.models[role];
    const provider = request.providerCatalog.find(
      (entry) => entry.provider.id === selected.providerId,
    );
    const model = provider?.models.find(
      (entry) => entry.definitionId === selected.modelDefinitionId,
    );
    return {
      role,
      providerId: selected.providerId,
      providerName: provider?.provider.displayName ?? selected.providerId,
      modelDefinitionId: selected.modelDefinitionId,
      modelName: model?.displayName ?? selected.modelDefinitionId,
    };
  });
}

/** Persistence is a precondition of every paid request, while existing runner callbacks stay synchronous. */
export function createRecordedWorkflowRunner(
  overrides: Partial<RecordedWorkflowDependencies> = {},
): RecordedWorkflowRunner {
  const dependencies: RecordedWorkflowDependencies = {
    historyClient: workflowHistoryClient,
    promptClient: promptNodeClient,
    generationClient,
    runnerFactory: defaultRunnerFactory,
    now: Date.now,
    createId: () => crypto.randomUUID(),
    ...overrides,
  };
  return {
    async run(input) {
      // Match serde's object-order independence before any template embeds configuration JSON.
      // JSON string values (user prose, exact titles, dialogue) remain byte-for-byte unchanged.
      const request = {
        ...input,
        node: JSON.parse(stableJsonSignature(input.node)) as KnowledgeVideoWorkflowNodeData,
      };
      let checkpoint = request.resume
        ? request.node.config.checkpoint
        : { ...request.node.config.checkpoint, runId: null, phase: "idle" as const, error: null };
      let latestProgress: KnowledgeVideoWorkflowRunState = {
        phase: checkpoint.phase,
        progress: 0,
        message:
          request.newHistory && request.resume
            ? "从已有画布断点建立历史记录"
            : request.resume
              ? "正在恢复工作流"
              : "正在启动工作流",
        error: null,
      };
      let queue = Promise.resolve();
      let persistenceFailure: unknown = null;
      let revision = 0;
      let record: WorkflowHistoryRecord | null = null;
      const historyId = request.node.config.historyRunId;
      const kind = workflowKindForNode(request.node);
      const publishFailure = (error: unknown, historyFailure: boolean) => {
        const message = `${historyFailure ? "工作流历史记录保存失败：" : "工作流历史恢复失败："}${formatWorkflowError(error)}`;
        checkpoint = { ...checkpoint, phase: "failed", error: message };
        request.onCheckpoint(checkpoint);
        request.onProgress({
          phase: "failed",
          progress: latestProgress.progress,
          message,
          error: message,
        });
        return checkpoint;
      };
      const enqueue = (event?: WorkflowHistoryEvent) => {
        if (!record) return;
        const captured = snapshot({
          ...record,
          status: checkpoint.phase,
          progress: latestProgress.progress,
          message: latestProgress.message,
          error: checkpoint.error ?? latestProgress.error,
          nodeSnapshot: { ...request.node, config: { ...request.node.config, checkpoint } },
          updatedAt: dependencies.now(),
        });
        queue = queue.then(async () => {
          if (persistenceFailure) return;
          try {
            const saved = await dependencies.historyClient.save({
              record: { ...captured, revision },
              ...(event ? { event } : {}),
            });
            revision = saved.revision;
            record = saved;
          } catch (error) {
            persistenceFailure = error;
          }
        });
      };
      const flush = async () => {
        let pending: Promise<void>;
        do {
          pending = queue;
          await pending;
        } while (pending !== queue);
        if (persistenceFailure) throw new Error(formatWorkflowError(persistenceFailure));
      };
      const beforeModelCall = async () => {
        await flush();
        if (request.signal.aborted) throw new DOMException("已暂停", "AbortError");
      };
      const eventFor = (state: KnowledgeVideoWorkflowRunState): WorkflowHistoryEvent => ({
        id: dependencies.createId(),
        phase: state.phase,
        progress: state.progress,
        message: state.message,
        error: state.error,
        createdAt: dependencies.now(),
      });
      try {
        if (!historyId) throw new Error("缺少工作流历史身份，尚未执行模型请求。");
        let priorTasks: readonly GenerationTaskDetail[] = [];
        const timestamp = dependencies.now();
        let detail: WorkflowHistoryDetail | null = null;
        if (request.resume && !request.newHistory) {
          try {
            detail = await dependencies.historyClient.get(historyId);
          } catch (error) {
            const missing =
              error != null &&
              typeof error === "object" &&
              "kind" in error &&
              error.kind === "not_found";
            if (!missing || checkpoint.runId)
              throw new Error(formatWorkflowError(error), { cause: error });
            latestProgress = { ...latestProgress, message: "重新建立尚未开始执行的历史记录" };
          }
        }
        if (detail) {
          if (detail.record.workflowKind !== kind || detail.record.canvasId !== CANVAS_ID)
            throw new Error("历史记录与当前工作流类型或画布不匹配。");
          // Reject edited references before enqueue can replace the archived original input.
          validateWorkflowMaterialsResume(request.node.config, {
            ...checkpoint,
            materialsSignature: workflowMaterialsSignature(detail.record.nodeSnapshot.config),
          });
          revision = detail.record.revision;
          record = {
            ...detail.record,
            sourceNodeId: request.node.key,
            models: modelSnapshots(request, kind),
            attemptCount: detail.record.attemptCount + 1,
          };
          const referenced = stringsIn(checkpoint);
          const candidates = detail.tasks.filter(
            (task) => !referenced.has(task.id) && task.status !== "failed",
          );
          const loaded = await Promise.all(
            candidates.map((task) => dependencies.generationClient.get(task.id)),
          );
          priorTasks = loaded.filter(
            (task) =>
              task.summary.status !== "failed" &&
              !task.results.some((result) => result.finalPath && referenced.has(result.finalPath)),
          );
        } else {
          const suppliedTitle = request.node.config.xhsCover?.title;
          const title = (suppliedTitle ? suppliedTitle : request.node.config.brief)
            .trim()
            .slice(0, 48);
          record = {
            id: historyId,
            canvasId: CANVAS_ID,
            sourceNodeId: request.node.key,
            workflowKind: kind,
            title: `${TITLES[kind]} · ${title ? title : "未命名"}`,
            status: checkpoint.phase,
            progress: 0,
            message: latestProgress.message,
            error: null,
            nodeSnapshot: snapshot(request.node),
            models: modelSnapshots(request, kind),
            attemptCount: 1,
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
        }
        enqueue(eventFor(latestProgress));
        await flush();
        if (request.resume && checkpoint.phase === "done") return checkpoint;
        const consumed = new Set<string>();
        const reusable = (
          command: OptimizeVideoPromptCommand | StartGenerationCommand,
          operation: "text" | "media",
        ) => {
          const key = commandKey(command, operation);
          const available = priorTasks.filter((task) => !consumed.has(task.summary.id));
          const matching = available.filter(
            (task) =>
              (operation === "text") === (task.summary.operation === "text_generation") &&
              commandKey(task.logicalRequest, operation) === key,
          );
          if (matching.length > 1)
            throw new Error(
              "历史中存在多个相同请求，无法唯一确认该恢复哪个任务。请先核实任务结果，避免重复计费。",
            );
          if (matching[0]) {
            consumed.add(matching[0].summary.id);
            return matching[0];
          }
          const uncertain = available.find(
            (task) => task.summary.status !== "succeeded" && task.summary.status !== "failed",
          );
          if (uncertain)
            throw new Error(
              `历史任务 ${uncertain.summary.id} 仍为 ${uncertain.summary.status}，且无法与当前步骤唯一对应。已阻止新模型请求，请先核实该任务。`,
            );
          return null;
        };
        const clients: RecordedClients = {
          promptClient: {
            async run(command) {
              await beforeModelCall();
              const previous = reusable(command, "text");
              if (previous) {
                if (previous.summary.status === "succeeded" && previous.textOutput)
                  return previous.textOutput;
                throw new Error(
                  `历史文本任务 ${previous.summary.id} 的输出尚不能确认（${previous.summary.status}），已阻止重复调用。请先核实该任务。`,
                );
              }
              return dependencies.promptClient.run({ ...command, workflowRunId: historyId });
            },
          },
          generationClient: {
            ...dependencies.generationClient,
            async start(command) {
              await beforeModelCall();
              const previous = reusable(command, "media");
              if (previous) return previous.summary.id;
              return dependencies.generationClient.start({ ...command, workflowRunId: historyId });
            },
          },
        };
        let lastEvent = latestProgress;
        checkpoint = await dependencies.runnerFactory(kind, clients).run({
          ...request,
          onCheckpoint(value) {
            checkpoint = value;
            request.onCheckpoint(value);
            enqueue();
          },
          onProgress(value) {
            latestProgress = value;
            request.onProgress(value);
            if (
              value.phase !== lastEvent.phase ||
              value.message !== lastEvent.message ||
              value.error !== lastEvent.error ||
              Math.abs(value.progress - lastEvent.progress) >= 10
            ) {
              lastEvent = value;
              enqueue(eventFor(value));
            }
          },
        });
        enqueue();
        await flush();
        return checkpoint;
      } catch (error) {
        await queue;
        if (
          !persistenceFailure &&
          (request.signal.aborted || (error instanceof Error && error.name === "AbortError"))
        ) {
          checkpoint = { ...checkpoint, phase: "paused", error: null };
          latestProgress = {
            phase: "paused",
            progress: latestProgress.progress,
            message: "已暂停，断点已保留",
            error: null,
          };
          request.onCheckpoint(checkpoint);
          request.onProgress(latestProgress);
          enqueue(eventFor(latestProgress));
          try {
            await flush();
            return checkpoint;
          } catch (saveError) {
            return publishFailure(saveError, true);
          }
        }
        const failed = publishFailure(persistenceFailure ?? error, persistenceFailure != null);
        if (record && !persistenceFailure) {
          latestProgress = {
            phase: "failed",
            progress: latestProgress.progress,
            message: failed.error!,
            error: failed.error,
          };
          enqueue(eventFor(latestProgress));
          try {
            await flush();
          } catch (saveError) {
            return publishFailure(saveError, true);
          }
        }
        return failed;
      }
    },
  };
}
