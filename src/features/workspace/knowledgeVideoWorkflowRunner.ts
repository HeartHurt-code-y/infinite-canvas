import {
  generationClient,
  promptNodeClient,
  videoComposerClient,
  videoFrameExtractionClient,
  type ConfiguredModel,
  type GenerationTaskClient,
  type PromptNodeClient,
  type TextSkillMode,
  type ProviderCatalogEntry,
  type VideoComposerClient,
  type VideoCompositionJobRecord,
  type VideoFrameExtractionClient,
  type ExplicitMediaInput,
} from "../../lib/backend";
import {
  generationParameters,
  modelParameterCapabilities,
  type ModelParameterCapability,
} from "../../lib/modelCapabilities";
import { formatWorkflowError } from "../../lib/workflowErrors";
import { stableJsonSignature } from "../../lib/workflowSignatures";
import {
  CANVAS_ID,
  isTextGenerationModel,
  type KnowledgeVideoWorkflowCheckpoint,
  type KnowledgeVideoWorkflowNodeData,
  type KnowledgeVideoWorkflowRunState,
  type KnowledgeVideoWorkflowSection,
  type KnowledgeVideoWorkflowShot,
  type KnowledgeVideoWorkflowShotRun,
  type KnowledgeVideoWorkflowTrack,
} from "./workspaceModel";
import { currentAiFilmAssets } from "./aiFilmWorkflowModel";
import {
  createVideoWorkflowExecutionSteps,
  createWorkflowDeliveryPlan,
  createWorkflowExecutionPlan,
  createWorkflowMediaReviewPlan,
  executeWorkflowSteps,
  getWorkflowExecutionPlan,
  isWorkflowExecutionPlanApproved,
  orderedWorkflowShots,
  workflowMediaReviewSignature,
  type WorkflowMediaReviewKind,
} from "./workflowExecutionPlan";
import {
  validateWorkflowMaterials,
  validateWorkflowMaterialsResume,
  withWorkflowMaterials,
  workflowMaterialsSignature,
} from "./workflowMaterials";

const SECTION_ORDER: readonly KnowledgeVideoWorkflowSection[] = [
  "HOOK",
  "CONCEPT",
  "VISUAL",
  "EXAMPLE",
  "PITFALL",
  "RECAP",
];
const TRACKS: readonly KnowledgeVideoWorkflowTrack[] = ["LECTURER", "DEMO", "METAPHOR"];
const FRAME_PERCENTAGES = [0.3, 0.6, 0.8, 0.95, 0.99] as const;
const UNCONFIRMED_STATUSES = new Set(["unknown", "interrupted"]);
const SAVE_FAILURES = new Set(["failed", "interrupted", "local_missing", "conflict"]);

export interface WorkflowPlan {
  readonly documentsOnly?: boolean;
  readonly manifest: string;
  readonly aspectRatio: string;
  readonly script: string;
  readonly storyboard: string;
  readonly shots: readonly KnowledgeVideoWorkflowShot[];
  readonly decision: KnowledgeVideoWorkflowCheckpoint["decision"];
}

interface WorkflowQcResult {
  readonly result: "PASS" | "RETRY" | "NEEDS_DECISION";
  readonly report: string;
  readonly repairPrompt: string | null;
  readonly question: string | null;
  readonly recommendation: string | null;
}

interface ResolvedWorkflowModels {
  readonly text: ConfiguredModel;
  readonly image: ConfiguredModel;
  readonly video: ConfiguredModel;
}

class QcRegenerationError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super(errorMessage(original));
    this.name = "QcRegenerationError";
    this.original = original;
  }
}

/** Only an explicit failed task status permits another paid submission. */
class ConfirmedGenerationFailure extends Error {
  constructor(taskId: string, details: unknown) {
    super(`任务 ${taskId} 已明确执行失败：${errorMessage(details)}`);
    this.name = "ConfirmedGenerationFailure";
  }
}

export interface KnowledgeVideoWorkflowRunRequest {
  readonly node: KnowledgeVideoWorkflowNodeData;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly resume?: boolean;
  readonly decisionResolution?: string;
  readonly signal: AbortSignal;
  /** Recorded execution flushes its approved checkpoint before local renderer/composer effects too. */
  readonly beforeSideEffect?: () => Promise<void>;
  readonly onCheckpoint: (checkpoint: KnowledgeVideoWorkflowCheckpoint) => void;
  readonly onProgress: (state: KnowledgeVideoWorkflowRunState) => void;
}

export interface KnowledgeVideoWorkflowRunner {
  run(request: KnowledgeVideoWorkflowRunRequest): Promise<KnowledgeVideoWorkflowCheckpoint>;
}

export interface KnowledgeVideoWorkflowRunnerDependencies {
  readonly promptClient: PromptNodeClient;
  readonly generationClient: GenerationTaskClient;
  readonly frameClient: VideoFrameExtractionClient;
  readonly composerClient: VideoComposerClient;
  readonly now: () => number;
  readonly createId: () => string;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface WorkflowPlanningContext {
  readonly request: KnowledgeVideoWorkflowRunRequest;
  readonly dependencies: KnowledgeVideoWorkflowRunnerDependencies;
  readonly checkpoint: () => KnowledgeVideoWorkflowCheckpoint;
  readonly commit: (
    update: (current: KnowledgeVideoWorkflowCheckpoint) => KnowledgeVideoWorkflowCheckpoint,
  ) => void;
  readonly progress: KnowledgeVideoWorkflowRunRequest["onProgress"];
  readonly resolution?: string;
}

export interface VideoWorkflowDefinition {
  readonly isPlanningComplete?: (checkpoint: KnowledgeVideoWorkflowCheckpoint) => boolean;
  readonly validateResume?: (
    request: KnowledgeVideoWorkflowRunRequest,
    checkpoint: KnowledgeVideoWorkflowCheckpoint,
  ) => void | Promise<void>;
  readonly requiresMediaReview?: boolean;
  readonly forceComposition?: boolean;
  readonly validateMedia?: (context: WorkflowPlanningContext) => void;
  readonly prepareShotMedia?: (
    context: WorkflowPlanningContext,
    shot: KnowledgeVideoWorkflowShot,
  ) => Promise<readonly ExplicitMediaInput[]>;
  readonly startComposition?: (
    context: WorkflowPlanningContext,
    clips: readonly { shot: KnowledgeVideoWorkflowShot; path: string }[],
  ) => Promise<VideoCompositionJobRecord>;
  readonly validateDelivery?: (
    context: WorkflowPlanningContext,
    finalPath: string,
  ) => Promise<void>;
  readonly qcMode?: TextSkillMode;
  readonly title: string;
  readonly plan: (context: WorkflowPlanningContext) => Promise<WorkflowPlan>;
  readonly initialize: (
    previous: KnowledgeVideoWorkflowCheckpoint,
  ) => Partial<KnowledgeVideoWorkflowCheckpoint>;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Workflow cancelled", "AbortError"));
      return;
    }
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Workflow cancelled", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

const DEFAULT_DEPENDENCIES: KnowledgeVideoWorkflowRunnerDependencies = {
  promptClient: promptNodeClient,
  generationClient,
  frameClient: videoFrameExtractionClient,
  composerClient: videoComposerClient,
  now: Date.now,
  createId: () =>
    `knowledge-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  sleep: defaultSleep,
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Workflow cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return formatWorkflowError(error);
}

function enabledModel(
  selection: { readonly providerId: string; readonly modelDefinitionId: string },
  catalog: readonly ProviderCatalogEntry[],
  accepts: (model: ConfiguredModel) => boolean,
): ConfiguredModel | null {
  const provider = catalog.find(
    (entry) => entry.provider.enabled && entry.provider.id === selection.providerId,
  );
  const model = provider?.models.find(
    (entry) => entry.definitionId === selection.modelDefinitionId && accepts(entry),
  );
  return model ?? null;
}

function resolveWorkflowModels(
  node: KnowledgeVideoWorkflowNodeData,
  catalog: readonly ProviderCatalogEntry[],
): ResolvedWorkflowModels {
  const text = enabledModel(node.config.models.text, catalog, isTextGenerationModel);
  const image = enabledModel(node.config.models.image, catalog, (model) =>
    model.operations.includes("text_to_image"),
  );
  const video = enabledModel(node.config.models.video, catalog, (model) =>
    model.operations.includes("video_generation"),
  );
  if (text == null) throw new Error("请在节点中选择项目内可用的文本模型。");
  if (image == null) throw new Error("请在节点中选择项目内可用的文生图模型。");
  if (video == null) throw new Error("请在节点中选择项目内可用的视频模型。");
  return { text, image, video };
}

function findBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`知识视频计划缺少 ${field} 对象。`);
  return value;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`知识视频计划缺少 ${field}。`);
  }
  return value.trim();
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`知识视频计划缺少 ${field} 数组。`);
  const items = value.map((item, index) => stringField(item, `${field}[${index}]`));
  if (items.length === 0) throw new Error(`知识视频计划的 ${field} 不能为空。`);
  return items;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function normalizedAspectRatio(value: unknown): string {
  const text = stringField(value, "project.aspectRatio").replaceAll("：", ":").replaceAll(" ", "");
  const match = text.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (match == null) throw new Error("知识视频计划的 project.aspectRatio 必须使用 W:H 格式。");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0 && height > 0)) {
    throw new Error("知识视频计划的 project.aspectRatio 必须为正数比例。");
  }
  return `${match[1]}:${match[2]}`;
}

function manifestDecision(
  status: string,
  rawDecision: unknown,
): KnowledgeVideoWorkflowCheckpoint["decision"] {
  if (status === "ready") {
    if (rawDecision != null) throw new Error("ready 计划的 decision 必须为 null。");
    return null;
  }
  if (status !== "needs_confirmation") return null;
  const decision = recordField(rawDecision, "decision");
  const rawOptions = decision["options"];
  if (!Array.isArray(rawOptions) || rawOptions.length < 1) {
    throw new Error("需要确认的计划没有提供 decision.options。");
  }
  const options: readonly unknown[] = rawOptions as readonly unknown[];
  const recommendedId = stringField(
    decision["recommendedOptionId"],
    "decision.recommendedOptionId",
  );
  const recommended = options.find((option) => isRecord(option) && option["id"] === recommendedId);
  if (!isRecord(recommended)) throw new Error("decision 的推荐选项不存在。");
  const label = stringField(recommended["label"], "decision.options[].label");
  const description =
    typeof recommended["description"] === "string" ? recommended["description"].trim() : "";
  return {
    kind: "planning",
    question: stringField(decision["question"], "decision.question"),
    recommendation: description ? `${label}：${description}` : label,
  };
}

/** 直接消费内置 V2.4 技能的 manifest，不再维护第二套互相冲突的 JSON 合同。 */
export function parseKnowledgeVideoPlan(raw: string): WorkflowPlan {
  const jsonText = findBalancedJsonObject(raw);
  if (jsonText == null) throw new Error("文本模型没有返回可解析的知识视频 manifest JSON。");
  const decoded = JSON.parse(jsonText) as unknown;
  const manifest = recordField(decoded, "manifest");
  if (
    stringField(manifest["schemaVersion"], "schemaVersion") !==
    "knowledge-video-director.manifest.v1"
  ) {
    throw new Error("知识视频计划的 schemaVersion 不受支持。");
  }
  const workflowVersion = manifest["workflowVersion"];
  if (workflowVersion !== "2.4" && workflowVersion !== 2.4) {
    throw new Error("知识视频计划的 workflowVersion 必须为 2.4。");
  }
  const status = stringField(manifest["status"], "status");
  if (!new Set(["ready", "needs_confirmation", "blocked"]).has(status)) {
    throw new Error("知识视频计划的 status 无效。");
  }
  if (status === "blocked") {
    const review = isRecord(manifest["review"]) ? manifest["review"] : null;
    const issues = review && Array.isArray(review["issues"]) ? review["issues"] : [];
    const detail = issues
      .flatMap((issue) =>
        isRecord(issue) && typeof issue["description"] === "string" ? [issue["description"]] : [],
      )
      .join("；");
    throw new Error(detail || "知识正文不足，无法生成可执行的知识视频计划。");
  }

  const project = recordField(manifest["project"], "project");
  const aspectRatio = normalizedAspectRatio(project["aspectRatio"]);
  const styleAnchor = recordField(manifest["styleAnchor"], "styleAnchor");
  const styleDescription = stringField(styleAnchor["description"], "styleAnchor.description");
  const review = recordField(manifest["review"], "review");
  if (
    status === "ready" &&
    stringField(review["result"], "review.result").toUpperCase() !== "PASS"
  ) {
    throw new Error("知识视频计划尚未通过 V2.4 自动审校。");
  }
  if (!Array.isArray(manifest["shots"])) throw new Error("知识视频计划缺少 shots 数组。");

  const seenIds = new Set<string>();
  let previousSectionIndex = -1;
  const shots = manifest["shots"].map((candidate, index): KnowledgeVideoWorkflowShot => {
    const shot = recordField(candidate, `shots[${index}]`);
    const sequenceText = stringField(shot["seq"], `shots[${index}].seq`);
    if (sequenceText !== String(index + 1).padStart(2, "0")) {
      throw new Error("知识视频计划的 seq 必须从 01 连续递增。");
    }
    const id = `shot-${sequenceText}`;
    if (seenIds.has(id)) throw new Error(`镜头主键 ${sequenceText} 重复。`);
    seenIds.add(id);
    const section = stringField(shot["section"], `shots[${index}].section`).toUpperCase();
    const sectionIndex = SECTION_ORDER.indexOf(section as KnowledgeVideoWorkflowSection);
    if (sectionIndex < 0) throw new Error(`第 ${index + 1} 个镜头的 section 无效。`);
    if (sectionIndex < previousSectionIndex) {
      throw new Error("知识视频计划的六段式 section 顺序错误。");
    }
    previousSectionIndex = sectionIndex;
    const track = stringField(shot["track"], `shots[${index}].track`).toUpperCase();
    if (!TRACKS.includes(track as KnowledgeVideoWorkflowTrack)) {
      throw new Error(`第 ${index + 1} 个镜头的 track 无法由自动工作流执行。`);
    }
    const durationSeconds = Number(shot["durationSeconds"]);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 4 || durationSeconds > 15) {
      throw new Error(`第 ${index + 1} 个镜头的时长必须在 4～15 秒。`);
    }
    const visual = stringField(shot["visual"], `shots[${index}].visual`);
    const narration = stringField(shot["narration"], `shots[${index}].narration`);
    const acceptance = stringList(shot["acceptance"], `shots[${index}].acceptance`).join("；");
    const samplePercents = shot["samplePercents"];
    if (
      !Array.isArray(samplePercents) ||
      samplePercents.length !== 5 ||
      !FRAME_PERCENTAGES.every((percentage, sampleIndex) =>
        Object.is(samplePercents[sampleIndex], percentage * 100),
      )
    ) {
      throw new Error(`第 ${index + 1} 个镜头缺少完整的五点验收比例。`);
    }
    return {
      id,
      sequence: index + 1,
      section: section as KnowledgeVideoWorkflowSection,
      track: track as KnowledgeVideoWorkflowTrack,
      title: `${sequenceText} · ${section}`,
      durationSeconds,
      visual,
      narration,
      videoPrompt: `${stringField(shot["videoPrompt"], `shots[${index}].videoPrompt`)}\n\n【目标画幅】${aspectRatio}\n【旁白台词（逐字使用）】${narration}`,
      imagePrompt:
        index === 0
          ? `${styleDescription}。${visual}。知识教学视频封面，目标画幅 ${aspectRatio}，画面清晰稳定，不含文字。`
          : null,
      acceptance,
    };
  });
  if (shots.length < 6 || shots.length > 30) {
    throw new Error("知识视频计划必须包含 6～30 个镜头。");
  }
  for (const section of SECTION_ORDER) {
    if (!shots.some((shot) => shot.section === section)) {
      throw new Error(`知识视频计划缺少 ${section} 阶段。`);
    }
  }

  const projectTitle = stringField(project["title"], "project.title");
  const script = [
    `# ${projectTitle} · 讲述脚本`,
    ...shots.map(
      (shot) => `## ${String(shot.sequence).padStart(2, "0")} ${shot.section}\n\n${shot.narration}`,
    ),
  ].join("\n\n");
  const storyboard = [
    `# ${projectTitle} · 六段式分镜`,
    "",
    `**统一风格 STYLE-A：** ${styleDescription}`,
    "",
    "| 镜头 | 段落 | 轨道 | 时长 | 画面 | 旁白 | 验收 |",
    "| --- | --- | --- | ---: | --- | --- | --- |",
    ...shots.map(
      (shot) =>
        `| ${String(shot.sequence).padStart(2, "0")} | ${shot.section} | ${shot.track} | ${shot.durationSeconds}s | ${markdownCell(shot.visual)} | ${markdownCell(shot.narration)} | ${markdownCell(shot.acceptance)} |`,
    ),
  ].join("\n");

  return {
    manifest: JSON.stringify(manifest, null, 2),
    aspectRatio,
    script,
    storyboard,
    shots,
    decision: manifestDecision(status, manifest["decision"]),
  };
}

export function parseKnowledgeVideoQc(raw: string): WorkflowQcResult {
  const jsonText = findBalancedJsonObject(raw);
  if (jsonText == null) throw new Error("质检模型没有返回可解析的 JSON。");
  const decoded = recordField(JSON.parse(jsonText) as unknown, "qc");
  const result = stringField(decoded["result"], "result").toUpperCase();
  if (result !== "PASS" && result !== "RETRY" && result !== "NEEDS_DECISION") {
    throw new Error("质检模型返回了无效的 result。");
  }
  const report =
    typeof decoded["report"] === "string" && decoded["report"].trim()
      ? decoded["report"].trim()
      : result;
  return {
    result,
    report,
    repairPrompt: result === "RETRY" ? stringField(decoded["repairPrompt"], "repairPrompt") : null,
    question: result === "NEEDS_DECISION" ? stringField(decoded["question"], "question") : null,
    recommendation:
      result === "NEEDS_DECISION" ? stringField(decoded["recommendation"], "recommendation") : null,
  };
}

function planningPrompt(brief: string, resolution?: string, parseFailure?: string): string {
  return `请严格按内置 V2.4 manifest 合同规划以下知识视频。当前项目会自动完成生成、抽帧质检和合成，所以每个镜头只使用 LECTURER、DEMO 或 METAPHOR 轨，并提供非空 videoPrompt；精确术语写入旁白和交付脚本，不要求生成画面呈现文字。常规制作细节使用技能默认值，只有会改变事实或核心业务方向的缺口才返回 needs_confirmation。${resolution ? `\n\n用户已经确认：${resolution}。请把该决定真正应用到脚本和全部受影响镜头，并返回 ready manifest。` : ""}${parseFailure ? `\n\n上一次输出无法执行：${parseFailure}。请修正后重新输出完整 JSON。` : ""}\n\n客户需求：\n${brief.trim()}`;
}

function qcPrompt(shot: KnowledgeVideoWorkflowShot): string {
  return `检查随请求提供的五张采样帧，它们依次来自镜头 ${shot.sequence} 的 30%、60%、80%、95%、99%。\n镜头段落：${shot.section}\n画面要求：${shot.visual}\n验收标准：${shot.acceptance}\n\n只返回 JSON：通过时 {"result":"PASS","report":"简短依据"}；存在可通过重新生成自动修复的问题时 {"result":"RETRY","report":"问题","repairPrompt":"追加到原视频提示词的具体正向修复要求"}；只有确实需要客户判断时 {"result":"NEEDS_DECISION","report":"问题","question":"一个问题","recommendation":"推荐答案"}。不要把审美偏好或可自动修复的问题交给客户。`;
}

function emptyShotRuns(shots: readonly KnowledgeVideoWorkflowShot[]) {
  return Object.fromEntries(
    shots.map((shot) => [
      shot.id,
      {
        shotId: shot.id,
        imageTaskId: null,
        videoTaskId: null,
        referenceImagePath: null,
        clipPath: null,
        qcStatus: "pending",
        qcReport: null,
        repairPrompt: null,
        retryCount: 0,
      } satisfies KnowledgeVideoWorkflowShotRun,
    ]),
  );
}

async function waitForGenerationResult(
  client: GenerationTaskClient,
  taskId: string,
  signal: AbortSignal,
  sleep: KnowledgeVideoWorkflowRunnerDependencies["sleep"],
): Promise<string> {
  for (let poll = 0; poll < 3600; poll += 1) {
    throwIfAborted(signal);
    const detail = await client.get(taskId).catch((error: unknown) => {
      if (isAbortError(error)) throw error;
      throw new Error(
        `任务 ${taskId} 查询暂时失败：${errorMessage(error)}。已保留原任务，重试时先查询，不会重复生成。`,
        { cause: error },
      );
    });
    throwIfAborted(signal);
    const saved = detail.results.find(
      (result) => result.saveStatus === "succeeded" && result.finalPath != null,
    );
    if (saved?.finalPath) return saved.finalPath;
    const saveFailure = detail.results.find((result) => SAVE_FAILURES.has(result.saveStatus));
    if (saveFailure) {
      throw new Error(
        `任务 ${taskId} 已生成但本地保存失败：${errorMessage(saveFailure.error ?? saveFailure.saveStatus)}。已保留原任务，请到任务详情处理本地保存后再重试，不会重新生成。`,
      );
    }
    if (detail.summary.status === "failed") {
      throw new ConfirmedGenerationFailure(taskId, detail.finalError ?? detail.summary.status);
    }
    if (UNCONFIRMED_STATUSES.has(detail.summary.status)) {
      throw new Error(
        `任务 ${taskId} 状态待确认：${detail.summary.status}。已保留原任务，请到任务详情确认后继续，不会自动重复生成。`,
      );
    }
    await sleep(1000, signal);
  }
  throw new Error(`任务 ${taskId} 等待超时。已保留原任务，重试时继续查询。`);
}

async function waitForFrameJob(
  client: VideoFrameExtractionClient,
  jobId: string,
  signal: AbortSignal,
  sleep: KnowledgeVideoWorkflowRunnerDependencies["sleep"],
) {
  for (let poll = 0; poll < 600; poll += 1) {
    throwIfAborted(signal);
    const job = await client.getJob(jobId);
    if (job.status === "completed") return job;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(job.error ?? `抽帧任务${job.status === "failed" ? "失败" : "已取消"}。`);
    }
    await sleep(500, signal);
  }
  throw new Error("抽帧任务等待超时。");
}

async function waitForComposition(
  client: VideoComposerClient,
  jobId: string,
  signal: AbortSignal,
  sleep: KnowledgeVideoWorkflowRunnerDependencies["sleep"],
): Promise<string> {
  for (let poll = 0; poll < 3600; poll += 1) {
    throwIfAborted(signal);
    const job = await client.getJob(jobId);
    if (job.status === "completed" && job.finalPath) return job.finalPath;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(job.error ?? `视频合成${job.status === "failed" ? "失败" : "已取消"}。`);
    }
    await sleep(500, signal);
  }
  throw new Error("视频合成等待超时。");
}

function mediaParameters(
  model: ConfiguredModel,
  operation: "text_to_image" | "video_generation",
  values: KnowledgeVideoWorkflowNodeData["config"]["imageParameterValues" | "videoParameterValues"],
  requestedAspectRatio: string,
) {
  const capabilities = modelParameterCapabilities(
    model.operationSchema,
    operation,
    model.remoteModelId,
  );
  return applyAspectRatioParameter(
    capabilities,
    generationParameters(capabilities, values, false),
    requestedAspectRatio,
  );
}

function numericAspectRatio(value: string): number | null {
  const normalized = value.trim().replaceAll("：", ":").replaceAll("×", "x");
  const ratioMatch = normalized.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  const sizeMatch = normalized.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i);
  const match = ratioMatch ?? sizeMatch;
  if (match == null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

function aspectCapabilityKind(key: string): "ratio" | "size" | null {
  const normalized = key.toLowerCase().replaceAll(/[-_]/g, "");
  if (normalized === "ratio" || normalized === "aspectratio") return "ratio";
  if (normalized === "size" || normalized === "imagesize" || normalized === "framesize") {
    return "size";
  }
  return null;
}

function closestAspectOption(
  capability: ModelParameterCapability,
  requestedAspectRatio: string,
): string | null {
  const target = numericAspectRatio(requestedAspectRatio);
  if (target == null) return null;
  const candidates = capability.options.flatMap((option) => {
    if (typeof option.value !== "string") return [];
    const ratio = numericAspectRatio(option.value);
    return ratio == null ? [] : [{ value: option.value, ratio }];
  });
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) =>
    Math.abs(Math.log(candidate.ratio / target)) < Math.abs(Math.log(best.ratio / target))
      ? candidate
      : best,
  ).value;
}

function applyAspectRatioParameter(
  capabilities: readonly ModelParameterCapability[],
  parameters: Record<string, string | number | boolean>,
  requestedAspectRatio: string,
) {
  for (const capability of capabilities) {
    const kind = aspectCapabilityKind(capability.key);
    if (kind == null || capability.type !== "string") continue;
    const closest = closestAspectOption(capability, requestedAspectRatio);
    if (closest != null) {
      parameters[capability.key] = closest;
      continue;
    }
    if (kind === "ratio" && capability.options.length === 0) {
      parameters[capability.key] = requestedAspectRatio;
    }
  }
  return parameters;
}

function storedManifestAspectRatio(manifestText: string): string | null {
  if (!manifestText.trim()) return null;
  try {
    const manifest = JSON.parse(manifestText) as unknown;
    if (!isRecord(manifest) || !isRecord(manifest["project"])) return null;
    return normalizedAspectRatio(manifest["project"]["aspectRatio"]);
  } catch {
    return null;
  }
}

function videoParametersForShot(
  model: ConfiguredModel,
  values: KnowledgeVideoWorkflowNodeData["config"]["videoParameterValues"],
  requestedDuration: number,
  requestedAspectRatio: string,
) {
  const capabilities = modelParameterCapabilities(
    model.operationSchema,
    "video_generation",
    model.remoteModelId,
  );
  const parameters = applyAspectRatioParameter(
    capabilities,
    generationParameters(capabilities, values, false),
    requestedAspectRatio,
  );
  const duration = capabilities.find((capability) => capability.key === "duration");
  if (duration == null) return parameters;
  const numericOptions = duration.options
    .map((option) => option.value)
    .filter((value): value is number => typeof value === "number" && value > 0);
  if (numericOptions.length > 0) {
    parameters["duration"] = numericOptions.reduce((best, value) =>
      Math.abs(value - requestedDuration) < Math.abs(best - requestedDuration) ? value : best,
    );
  } else {
    let value = requestedDuration;
    if (duration.minimum != null) value = Math.max(duration.minimum, value);
    if (duration.maximum != null) value = Math.min(duration.maximum, value);
    parameters["duration"] = duration.type === "integer" ? Math.round(value) : value;
  }
  return parameters;
}

/** 首个 worker 失败后停止领取新镜头，但等待已经提交的 worker 收口，避免幽灵任务。 */
async function runPool<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!failed && nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          await worker(values[index]!, index);
        } catch (error: unknown) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
}

function persistedStage(
  phase: KnowledgeVideoWorkflowCheckpoint["phase"],
  fallback: KnowledgeVideoWorkflowCheckpoint["lastActivePhase"],
): KnowledgeVideoWorkflowCheckpoint["lastActivePhase"] {
  return phase === "planning" || phase === "generating" || phase === "qc" || phase === "composing"
    ? phase
    : fallback;
}

function failedProgress(phase: KnowledgeVideoWorkflowCheckpoint["lastActivePhase"]): number {
  if (phase === "planning") return 8;
  if (phase === "generating") return 45;
  if (phase === "qc") return 78;
  if (phase === "composing") return 92;
  return 0;
}

async function readExistingComposition(
  client: VideoComposerClient,
  jobId: string,
  signal: AbortSignal,
  sleep: KnowledgeVideoWorkflowRunnerDependencies["sleep"],
): Promise<VideoCompositionJobRecord | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await client.getJob(jobId);
    } catch {
      if (attempt < 2) await sleep(400, signal);
    }
  }
  return null;
}

export function createKnowledgeVideoWorkflowRunner(
  dependencyOverrides: Partial<KnowledgeVideoWorkflowRunnerDependencies> = {},
  definition?: VideoWorkflowDefinition,
): KnowledgeVideoWorkflowRunner {
  const baseDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };

  return {
    async run(request) {
      const { node, providerCatalog, signal, onCheckpoint, onProgress } = request;
      const dependencies = {
        ...baseDependencies,
        promptClient: withWorkflowMaterials(baseDependencies.promptClient, node.config),
      };
      const workflowTitle = definition?.title ?? "知识视频";
      let checkpoint = node.config.checkpoint;
      let requestedAspectRatio = storedManifestAspectRatio(checkpoint.manifest) ?? "16:9";
      const commit = (
        update: (current: KnowledgeVideoWorkflowCheckpoint) => KnowledgeVideoWorkflowCheckpoint,
      ) => {
        const next = update(checkpoint);
        const executionPlan =
          next.executionPlan ?? checkpoint.executionPlan ?? node.config.executionPlan;
        checkpoint = {
          ...next,
          ...(executionPlan ? { executionPlan } : {}),
          updatedAt: dependencies.now(),
        };
        onCheckpoint(checkpoint);
      };
      const progress = (
        phase: KnowledgeVideoWorkflowRunState["phase"],
        percentage: number,
        message: string,
        error: string | null = null,
      ) => onProgress({ phase, progress: percentage, message, error });
      const context = (): WorkflowPlanningContext => ({
        request,
        dependencies,
        checkpoint: () => checkpoint,
        commit,
        progress: onProgress,
      });

      const requireMediaReview = (kind: WorkflowMediaReviewKind): boolean => {
        if (!getWorkflowExecutionPlan(node) && !definition?.requiresMediaReview) return true;
        const signature = workflowMediaReviewSignature(checkpoint, kind);
        if (checkpoint.mediaApprovals?.[kind]?.signature === signature) return true;
        const currentNode = { ...node, config: { ...node.config, checkpoint } };
        const plan = getWorkflowExecutionPlan(currentNode);
        if (
          plan?.review?.kind === kind &&
          plan.review.signature === signature &&
          isWorkflowExecutionPlanApproved(plan, currentNode)
        ) {
          commit((current) => ({
            ...current,
            mediaApprovals: {
              ...current.mediaApprovals,
              [kind]: { signature, approvedAt: plan.approval!.approvedAt },
            },
          }));
          return true;
        }
        const messages: Record<WorkflowMediaReviewKind, string> = {
          assets: "资产图已生成，请检查人物、场景和道具后确认试产首镜。",
          first_shot: "首镜试产已完成，请检查画面和风格后确认批量制作。",
          composition: "全部分镜视频已完成，请预览并确认采用这些片段后合成。",
          final: "成片已生成，请预览并确认最终交付。",
        };
        if (node.config.musicVideo) {
          messages.first_shot =
            "首段 MV 试产已完成，请试听并检查人物、风格、节拍及实际嘴型；确认后才批量制作。";
          messages.composition =
            "全部 MV 片段已完成，请逐段试听检查唱词、节拍和嘴型，确认采用后贴原曲合成。";
          messages.final = "原曲 MV 已合成，请试听成片确认交付；音视频时长检查不代表口型通过。";
        }
        commit((current) => ({
          ...current,
          executionPlan: createWorkflowMediaReviewPlan(currentNode, kind),
          phase: "awaiting_approval",
          decision: null,
          error: null,
        }));
        progress(
          "awaiting_approval",
          kind === "final" ? 98 : kind === "composition" ? 88 : 24,
          messages[kind],
        );
        return false;
      };

      const requestPlan = async (resolution?: string): Promise<WorkflowPlan> => {
        if (definition) {
          return definition.plan({
            request,
            dependencies,
            checkpoint: () => checkpoint,
            commit,
            progress: onProgress,
            ...(resolution === undefined ? {} : { resolution }),
          });
        }
        let plan: WorkflowPlan | null = null;
        let parseFailure = "";
        for (let attempt = 0; attempt < 2 && plan == null; attempt += 1) {
          throwIfAborted(signal);
          const result = await dependencies.promptClient.run({
            canvasId: CANVAS_ID,
            sourceNodeId: node.key,
            providerConnectionId: node.config.models.text.providerId,
            modelDefinitionId: node.config.models.text.modelDefinitionId,
            mode: "knowledge_video_director",
            task: "generate",
            userPrompt: planningPrompt(
              node.config.brief,
              resolution,
              attempt === 0 ? undefined : parseFailure,
            ),
          });
          throwIfAborted(signal);
          try {
            plan = parseKnowledgeVideoPlan(result.optimizedPrompt);
          } catch (error: unknown) {
            parseFailure = errorMessage(error);
          }
        }
        if (plan == null) throw new Error(parseFailure || "知识视频计划生成失败。");
        return plan;
      };

      const applyPlan = (plan: WorkflowPlan) => {
        requestedAspectRatio = plan.aspectRatio;
        const planRevision = checkpoint.planRevision + 1;
        commit((current) => ({
          ...current,
          phase: plan.decision ? "awaiting_approval" : "generating",
          lastActivePhase: "planning",
          planRevision,
          approvedPlanRevision: plan.decision ? null : planRevision,
          manifest: plan.manifest,
          script: plan.script,
          storyboard: plan.storyboard,
          shots: plan.shots,
          shotRuns: node.config.musicVideo
            ? {
                ...current.shotRuns,
                ...Object.fromEntries(
                  plan.shots.map((shot) => {
                    const previous = current.shots.find((item) => item.id === shot.id);
                    const run = current.shotRuns[shot.id];
                    return [
                      shot.id,
                      run
                        ? {
                            ...run,
                            ...(previous &&
                            stableJsonSignature(previous) === stableJsonSignature(shot)
                              ? {}
                              : { promptEdited: true }),
                          }
                        : { shotId: shot.id, qcStatus: "pending" as const, retryCount: 0 },
                    ];
                  }),
                ),
              }
            : emptyShotRuns(plan.shots),
          decision: plan.decision,
          ...(plan.documentsOnly === undefined ? {} : { documentsOnly: plan.documentsOnly }),
        }));
      };

      try {
        throwIfAborted(signal);
        if (
          definition?.requiresMediaReview &&
          !isWorkflowExecutionPlanApproved(getWorkflowExecutionPlan(node), node)
        ) {
          commit((current) => ({
            ...current,
            executionPlan: createWorkflowExecutionPlan(node, request.resume ? "resume" : "restart"),
            phase: "awaiting_approval",
            decision: null,
            error: null,
          }));
          progress("awaiting_approval", 0, "请先审阅并确认本次工作流执行计划。");
          return checkpoint;
        }
        if (
          !node.config.brief.trim() &&
          !node.config.comicDrama?.episodes.some((episode) => episode.script.trim()) &&
          !node.config.commerce &&
          !node.config.musicVideo
        )
          throw new Error("请先填写制作要求或原文。");
        if (!enabledModel(node.config.models.text, providerCatalog, isTextGenerationModel)) {
          throw new Error("请在节点中选择项目内可用的文本模型。");
        }

        const startsNewRun =
          !request.resume ||
          checkpoint.runId == null ||
          checkpoint.phase === "idle" ||
          checkpoint.phase === "done" ||
          (checkpoint.shots.length === 0 &&
            checkpoint.film == null &&
            checkpoint.comicDrama == null &&
            checkpoint.commerce == null &&
            checkpoint.musicVideo == null);
        validateWorkflowMaterials(node.config);
        if (!startsNewRun) {
          validateWorkflowMaterialsResume(node.config, checkpoint);
          await definition?.validateResume?.(request, checkpoint);
        }
        if (startsNewRun) {
          const runId = dependencies.createId();
          commit(() => ({
            version: 1,
            materialsSignature: workflowMaterialsSignature(node.config),
            runId,
            phase: "planning",
            lastActivePhase: "planning",
            planRevision: checkpoint.planRevision,
            approvedPlanRevision: null,
            manifest: "",
            script: "",
            storyboard: "",
            shots: [],
            shotRuns: {},
            decision: null,
            coverImagePath: null,
            activeCompositionJobId: null,
            finalPath: null,
            error: null,
            updatedAt: dependencies.now(),
            ...definition?.initialize(checkpoint),
          }));
          progress(
            "planning",
            4,
            definition ? `正在安排${workflowTitle}制作阶段…` : "正在诊断内容并生成六段式执行计划…",
          );
          applyPlan(await requestPlan());
          if (checkpoint.decision) {
            progress("awaiting_approval", 18, "有一个关键业务信息需要确认后继续。");
            return checkpoint;
          }
        } else if (
          definition &&
          (definition.isPlanningComplete
            ? !definition.isPlanningComplete(checkpoint)
            : checkpoint.film && !checkpoint.film.planningComplete)
        ) {
          const resolution =
            request.decisionResolution?.trim() ?? checkpoint.decision?.recommendation;
          commit((current) => ({
            ...current,
            phase: "planning",
            lastActivePhase: "planning",
            error: null,
            decision:
              current.decision && resolution
                ? { ...current.decision, recommendation: resolution }
                : current.decision,
          }));
          applyPlan(await requestPlan(resolution));
          if (checkpoint.decision) {
            progress("awaiting_approval", 18, "有一项制作决策需要确认。");
            return checkpoint;
          }
        } else if (
          checkpoint.phase === "awaiting_approval" &&
          !checkpoint.decision &&
          getWorkflowExecutionPlan(node)?.scope === "delivery" &&
          isWorkflowExecutionPlanApproved(getWorkflowExecutionPlan(node), node)
        ) {
          commit((current) => ({
            ...current,
            phase: "generating",
            error: null,
            approvedPlanRevision: current.planRevision,
          }));
        } else if (
          checkpoint.phase === "awaiting_approval" ||
          checkpoint.decision?.kind === "planning"
        ) {
          const decision = checkpoint.decision;
          const decisionKind =
            decision?.kind ??
            (Object.values(checkpoint.shotRuns).some((run) => run.qcStatus === "failed")
              ? "qc"
              : "planning");
          if (decisionKind === "planning") {
            if (!decision) throw new Error("缺少待确认的规划决定。");
            const customerAnswer = request.decisionResolution?.trim();
            const resolution = customerAnswer ? customerAnswer : decision.recommendation;
            commit((current) => ({
              ...current,
              phase: "planning",
              lastActivePhase: "planning",
              decision: { ...decision, recommendation: resolution },
              error: null,
            }));
            progress("planning", 12, "正在把已确认的答案应用到脚本与分镜…");
            applyPlan(await requestPlan(resolution));
            if (checkpoint.decision) {
              progress("awaiting_approval", 18, "仍有一项关键业务信息需要确认。");
              return checkpoint;
            }
          } else {
            commit((current) => ({
              ...current,
              phase: "qc",
              lastActivePhase: "qc",
              approvedPlanRevision: current.planRevision,
              decision: null,
              shotRuns: Object.fromEntries(
                Object.entries(current.shotRuns).map(([key, run]) => [
                  key,
                  run.qcStatus === "failed"
                    ? {
                        ...run,
                        qcStatus: "passed",
                        qcReport: `${run.qcReport ?? ""}\n用户已确认采用推荐方案继续。`.trim(),
                      }
                    : run,
                ]),
              ),
            }));
          }
        } else if (checkpoint.phase === "failed") {
          commit((current) => ({
            ...current,
            phase: current.shots.some((shot) => current.shotRuns[shot.id]?.clipPath == null)
              ? "generating"
              : current.shots.some((shot) => current.shotRuns[shot.id]?.qcStatus !== "passed")
                ? "qc"
                : "composing",
            error: null,
            shotRuns: Object.fromEntries(
              Object.entries(current.shotRuns).map(([key, run]) => [
                key,
                run.clipPath || run.videoTaskId ? run : { ...run, retryCount: 0, qcReport: null },
              ]),
            ),
          }));
        } else if (checkpoint.phase === "paused") {
          commit((current) => ({
            ...current,
            phase: current.shots.some((shot) => current.shotRuns[shot.id]?.clipPath == null)
              ? "generating"
              : current.shots.some((shot) => current.shotRuns[shot.id]?.qcStatus !== "passed")
                ? "qc"
                : "composing",
            error: null,
          }));
        }

        throwIfAborted(signal);
        if (
          checkpoint.documentsOnly ||
          node.config.film?.deliverable === "documents" ||
          node.config.comicDrama?.deliverable === "documents" ||
          node.config.commerce?.deliverable === "documents" ||
          node.config.musicVideo?.deliverable === "documents"
        ) {
          commit((current) => ({
            ...current,
            documentsOnly: true,
            phase: "done",
            error: null,
            decision: null,
          }));
          progress("done", 100, "制作文档已完成并保存在节点中。");
          return checkpoint;
        }
        definition?.validateMedia?.(context());
        const models = resolveWorkflowModels(node, providerCatalog);
        // The initial review authorizes planning only. Actual generated shot prompts and dependencies
        // receive a separate review before the first paid image/video submission.
        if (getWorkflowExecutionPlan(node) || definition?.requiresMediaReview) {
          const plannedNode = { ...node, config: { ...node.config, checkpoint } };
          const approved = getWorkflowExecutionPlan(plannedNode);
          if (
            approved?.scope !== "delivery" ||
            !isWorkflowExecutionPlanApproved(approved, plannedNode)
          ) {
            const executionPlan = createWorkflowDeliveryPlan(plannedNode, checkpoint);
            commit((current) => ({
              ...current,
              executionPlan,
              phase: "awaiting_approval",
              approvedPlanRevision: null,
              decision: null,
              error: null,
            }));
            progress(
              "awaiting_approval",
              20,
              "脚本与分镜已生成，请确认具体镜头、依赖和执行顺序后制作媒体。",
            );
            return checkpoint;
          }
        }
        if (checkpoint.shots.some((shot) => checkpoint.shotRuns[shot.id]?.promptEdited)) {
          const invalidated = new Set(
            checkpoint.shots
              .filter((shot) => checkpoint.shotRuns[shot.id]?.promptEdited)
              .map((shot) => shot.id),
          );
          for (const shot of orderedWorkflowShots(checkpoint))
            if (shot.dependsOn.some((id) => invalidated.has(id))) invalidated.add(shot.id);
          commit((current) => ({
            ...current,
            finalPath: null,
            activeCompositionJobId: null,
            mediaApprovals: {},
            shotRuns: Object.fromEntries(
              Object.entries(current.shotRuns).map(([id, run]) => [
                id,
                invalidated.has(id)
                  ? {
                      ...run,
                      promptEdited: false,
                      videoTaskId: null,
                      clipPath: null,
                      qcStatus: "pending" as const,
                      retryCount: 0,
                      repairPrompt: null,
                      redoRequested: true,
                      supersededTaskIds: [
                        ...(run.supersededTaskIds ?? []),
                        ...(run.videoTaskId ? [run.videoTaskId] : []),
                      ],
                    }
                  : run,
              ]),
            ),
          }));
        }
        if (checkpoint.film) {
          for (const shot of checkpoint.shots) {
            const parameters = videoParametersForShot(
              models.video,
              node.config.videoParameterValues,
              shot.durationSeconds,
              requestedAspectRatio,
            );
            if (
              typeof parameters["duration"] === "number" &&
              parameters["duration"] !== shot.durationSeconds
            ) {
              throw new Error(
                `镜头 ${shot.id} 的 ${shot.durationSeconds} 秒时长与当前视频模型不兼容。请恢复原视频模型，或重新制作以按新模型时长更新镜头。`,
              );
            }
          }
        }
        progress("generating", 22, "正在生成封面与视频片段…");
        const prepareAssets = async () => {
          const filmAssets = currentAiFilmAssets(checkpoint.film);
          if (filmAssets.length) {
            await runPool(filmAssets, 2, async (asset) => {
              for (let attempt = 0; attempt <= node.config.maxAutomaticRetries; attempt += 1) {
                throwIfAborted(signal);
                const currentAsset = checkpoint.film!.assets.find((item) => item.id === asset.id)!;
                if (currentAsset.path) return;
                try {
                  let taskId = currentAsset.taskId;
                  if (!taskId) {
                    taskId = await dependencies.generationClient.start({
                      canvasId: CANVAS_ID,
                      sourceNodeId: node.key,
                      operation: "text_to_image",
                      providerConnectionId: node.config.models.image.providerId,
                      modelDefinitionId: node.config.models.image.modelDefinitionId,
                      prompt: [{ kind: "text", text: asset.prompt }],
                      parameters: mediaParameters(
                        models.image,
                        "text_to_image",
                        node.config.imageParameterValues,
                        requestedAspectRatio,
                      ),
                      generationCount: 1,
                    });
                    const savedTaskId = taskId;
                    commit((current) => ({
                      ...current,
                      film: {
                        ...current.film!,
                        assets: current.film!.assets.map((item) =>
                          item.id === asset.id ? { ...item, taskId: savedTaskId } : item,
                        ),
                      },
                    }));
                  }
                  const path = await waitForGenerationResult(
                    dependencies.generationClient,
                    taskId,
                    signal,
                    dependencies.sleep,
                  );
                  commit((current) => ({
                    ...current,
                    film: {
                      ...current.film!,
                      assets: current.film!.assets.map((item) =>
                        item.id === asset.id ? { ...item, path } : item,
                      ),
                    },
                  }));
                  return;
                } catch (error: unknown) {
                  if (!(error instanceof ConfirmedGenerationFailure)) throw error;
                  commit((current) => ({
                    ...current,
                    film: {
                      ...current.film!,
                      assets: current.film!.assets.map((item) =>
                        item.id === asset.id ? { ...item, taskId: null } : item,
                      ),
                    },
                  }));
                  if (attempt >= node.config.maxAutomaticRetries) throw error;
                }
              }
            });
            commit((current) => ({
              ...current,
              coverImagePath: currentAiFilmAssets(current.film)[0]?.path ?? null,
            }));
          }
        };
        const prepareCover = async () => {
          const firstShot = checkpoint.shots[0];
          const coverPrompt = firstShot?.imagePrompt?.trim();
          for (
            let coverAttempt = 0;
            firstShot &&
            coverPrompt &&
            !checkpoint.coverImagePath &&
            coverAttempt <= node.config.maxAutomaticRetries;
            coverAttempt += 1
          ) {
            throwIfAborted(signal);
            try {
              const firstRun = checkpoint.shotRuns[firstShot.id]!;
              let imageTaskId = firstRun.imageTaskId ?? null;
              if (!imageTaskId) {
                imageTaskId = await dependencies.generationClient.start({
                  canvasId: CANVAS_ID,
                  sourceNodeId: node.key,
                  operation: "text_to_image",
                  providerConnectionId: node.config.models.image.providerId,
                  modelDefinitionId: node.config.models.image.modelDefinitionId,
                  prompt: [{ kind: "text", text: coverPrompt }],
                  parameters: mediaParameters(
                    models.image,
                    "text_to_image",
                    node.config.imageParameterValues,
                    requestedAspectRatio,
                  ),
                  generationCount: 1,
                });
                commit((current) => ({
                  ...current,
                  phase: "generating",
                  lastActivePhase: "generating",
                  shotRuns: {
                    ...current.shotRuns,
                    [firstShot.id]: { ...current.shotRuns[firstShot.id]!, imageTaskId },
                  },
                }));
              }
              const coverImagePath = await waitForGenerationResult(
                dependencies.generationClient,
                imageTaskId,
                signal,
                dependencies.sleep,
              );
              commit((current) => ({
                ...current,
                coverImagePath,
                shotRuns: {
                  ...current.shotRuns,
                  [firstShot.id]: {
                    ...current.shotRuns[firstShot.id]!,
                    referenceImagePath: coverImagePath,
                  },
                },
              }));
            } catch (error: unknown) {
              if (!(error instanceof ConfirmedGenerationFailure)) throw error;
              commit((current) => ({
                ...current,
                shotRuns: {
                  ...current.shotRuns,
                  [firstShot.id]: {
                    ...current.shotRuns[firstShot.id]!,
                    imageTaskId: null,
                    qcReport: `封面生成失败：${errorMessage(error)}`,
                  },
                },
              }));
              if (coverAttempt >= node.config.maxAutomaticRetries) {
                throw new Error(`封面生成失败：${errorMessage(error)}`, { cause: error });
              }
            }
          }
        };

        let completedShots = checkpoint.shots.filter(
          (shot) => checkpoint.shotRuns[shot.id]?.clipPath,
        ).length;
        const generateShot = async (shot: KnowledgeVideoWorkflowShot) => {
          let run = checkpoint.shotRuns[shot.id]!;
          if (
            run.clipPath &&
            shot.continuationFromShotId &&
            run.continuationSourcePath !==
              checkpoint.shotRuns[shot.continuationFromShotId]?.clipPath
          ) {
            commit((current) => ({
              ...current,
              finalPath: null,
              activeCompositionJobId: null,
              shotRuns: {
                ...current.shotRuns,
                [shot.id]: {
                  ...current.shotRuns[shot.id]!,
                  videoTaskId: null,
                  clipPath: null,
                  qcStatus: "pending",
                  retryCount: 0,
                  repairPrompt: null,
                  supersededTaskIds: [
                    ...(run.supersededTaskIds ?? []),
                    ...(run.videoTaskId ? [run.videoTaskId] : []),
                  ],
                },
              },
            }));
            run = checkpoint.shotRuns[shot.id]!;
          }
          if (run.clipPath) return;
          for (
            let attempt = Math.min(run.retryCount, node.config.maxAutomaticRetries);
            attempt <= node.config.maxAutomaticRetries;
            attempt += 1
          ) {
            throwIfAborted(signal);
            run = checkpoint.shotRuns[shot.id]!;
            try {
              let taskId = run.videoTaskId ?? null;
              if (!taskId) {
                let prompt = run.repairPrompt
                  ? `${shot.videoPrompt}\n\n自动质检修复要求：${run.repairPrompt}`
                  : shot.videoPrompt;
                const explicitMedia: ExplicitMediaInput[] = (
                  checkpoint.film ? (shot.referenceAssetIds ?? []) : []
                ).map((id, index) => {
                  const asset = currentAiFilmAssets(checkpoint.film).find((item) => item.id === id);
                  if (!asset?.path)
                    throw new Error(`镜头 ${shot.title} 缺少已生成的参考资产 ${id}。`);
                  return {
                    target: {
                      kind: "local_file" as const,
                      path: asset.path,
                      mediaType: "image" as const,
                    },
                    role: "reference_image",
                    displayNameSnapshot: asset.name,
                    typePosition: index + 1,
                    contentIndex: index + 1,
                  };
                });
                if (definition?.prepareShotMedia) {
                  await request.beforeSideEffect?.();
                  explicitMedia.push(...(await definition.prepareShotMedia(context(), shot)));
                  throwIfAborted(signal);
                }
                if (shot.continuationFromShotId) {
                  const predecessor = checkpoint.shotRuns[shot.continuationFromShotId];
                  if (!predecessor?.clipPath || predecessor.qcStatus !== "passed")
                    throw new Error(
                      `接续镜头 ${shot.id} 的前置镜头 ${shot.continuationFromShotId} 尚未生成并通过质检。`,
                    );
                  let tailPath =
                    run.continuationSourcePath === predecessor.clipPath
                      ? run.continuationReferencePath
                      : null;
                  if (!tailPath) {
                    await request.beforeSideEffect?.();
                    const extraction = await dependencies.frameClient.startExtraction(
                      predecessor.clipPath,
                      [],
                      [0.99],
                    );
                    const frames = await waitForFrameJob(
                      dependencies.frameClient,
                      extraction.jobId,
                      signal,
                      dependencies.sleep,
                    );
                    tailPath = frames.frames.at(-1)?.path;
                    if (!tailPath)
                      throw new Error(
                        `前置镜头 ${shot.continuationFromShotId} 没有返回可用的尾帧。`,
                      );
                    const path = tailPath;
                    commit((current) => ({
                      ...current,
                      shotRuns: {
                        ...current.shotRuns,
                        [shot.id]: {
                          ...current.shotRuns[shot.id]!,
                          continuationReferencePath: path,
                          continuationSourcePath: predecessor.clipPath ?? null,
                        },
                      },
                    }));
                  }
                  const referenceIndex = explicitMedia.length + 1;
                  explicitMedia.push({
                    target: { kind: "local_file", path: tailPath, mediaType: "image" },
                    role: "reference_image",
                    displayNameSnapshot: `镜头 ${shot.continuationFromShotId} 的接续尾帧`,
                    typePosition: referenceIndex,
                    contentIndex: referenceIndex,
                  });
                  prompt += `\n【镜头接续】参考图 ${referenceIndex} 是前置镜头 ${shot.continuationFromShotId} 的实际尾帧；从该画面的角色位置、朝向、构图和动作状态连续起拍。`;
                }
                taskId = await dependencies.generationClient.start({
                  canvasId: CANVAS_ID,
                  sourceNodeId: node.key,
                  operation: "video_generation",
                  providerConnectionId: node.config.models.video.providerId,
                  modelDefinitionId: node.config.models.video.modelDefinitionId,
                  prompt: [{ kind: "text", text: prompt }],
                  ...(explicitMedia.length || checkpoint.film ? { explicitMedia } : {}),
                  parameters: videoParametersForShot(
                    models.video,
                    node.config.videoParameterValues,
                    shot.durationSeconds,
                    requestedAspectRatio,
                  ),
                  generationCount: 1,
                });
                commit((current) => ({
                  ...current,
                  phase: "generating",
                  lastActivePhase: "generating",
                  shotRuns: {
                    ...current.shotRuns,
                    [shot.id]: {
                      ...current.shotRuns[shot.id]!,
                      videoTaskId: taskId,
                      retryCount: attempt,
                    },
                  },
                }));
              }
              const clipPath = await waitForGenerationResult(
                dependencies.generationClient,
                taskId,
                signal,
                dependencies.sleep,
              );
              commit((current) => ({
                ...current,
                shotRuns: {
                  ...current.shotRuns,
                  [shot.id]: {
                    ...current.shotRuns[shot.id]!,
                    clipPath,
                    qcStatus: "pending",
                    promptEdited: false,
                    redoRequested: false,
                  },
                },
              }));
              completedShots += 1;
              progress(
                "generating",
                25 + Math.round((completedShots / checkpoint.shots.length) * 45),
                `已完成 ${completedShots}/${checkpoint.shots.length} 个视频片段。`,
              );
              return;
            } catch (error: unknown) {
              if (!(error instanceof ConfirmedGenerationFailure)) throw error;
              commit((current) => ({
                ...current,
                shotRuns: {
                  ...current.shotRuns,
                  [shot.id]: {
                    ...current.shotRuns[shot.id]!,
                    videoTaskId: null,
                    retryCount: attempt + 1,
                    qcReport: `第 ${attempt + 1} 次生成已明确失败，${attempt >= node.config.maxAutomaticRetries ? "已达到自动重试上限" : "正在自动重试"}：${errorMessage(error)}`,
                  },
                },
              }));
              if (attempt >= node.config.maxAutomaticRetries) throw error;
            }
          }
        };

        const checkShot = async (shot: KnowledgeVideoWorkflowShot) => {
          const index = checkpoint.shots.findIndex((item) => item.id === shot.id);
          commit((current) => ({ ...current, phase: "qc", lastActivePhase: "qc" }));
          progress("qc", 74, "正在按 30% / 60% / 80% / 95% / 99% 自动抽帧验收…");
          throwIfAborted(signal);
          let run = checkpoint.shotRuns[shot.id]!;
          if (run.qcStatus === "passed") return;
          let qcInfrastructureFailure = "";
          let finished = false;
          for (
            let qcAttempt = 0;
            qcAttempt <= node.config.maxAutomaticRetries && !finished;
            qcAttempt += 1
          ) {
            try {
              await request.beforeSideEffect?.();
              const started = await dependencies.frameClient.startExtraction(
                run.clipPath!,
                [],
                FRAME_PERCENTAGES,
              );
              const frameJob = await waitForFrameJob(
                dependencies.frameClient,
                started.jobId,
                signal,
                dependencies.sleep,
              );
              if (frameJob.frames.length !== FRAME_PERCENTAGES.length) {
                throw new Error(
                  `抽帧只返回 ${frameJob.frames.length}/${FRAME_PERCENTAGES.length} 张。`,
                );
              }
              const productReferences = node.config.commerce
                ? (shot.referenceAssetIds ?? []).flatMap((id) => {
                    if (!id.startsWith("product-")) return [];
                    const asset = checkpoint.film?.assets.find((item) => item.id === id);
                    if (!asset?.path) throw new Error(`产品质检缺少原图 ${id}。`);
                    return [{ id, path: asset.path, name: asset.name }];
                  })
                : [];
              const sampleMaterials = frameJob.frames.map((frame, frameIndex) => ({
                localPath: frame.path,
                displayName: `镜头${shot.sequence}-采样${frameIndex + 1}.png`,
                kind: "image" as const,
                mimeType: frame.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
              }));
              // Generated evidence has its own vision channel, leaving the eight reference slots
              // available to the user's materials. Preserve legacy commands for archived retries.
              const visionImages = [
                ...productReferences.map((asset) => ({
                  target: {
                    kind: "local_file" as const,
                    path: asset.path,
                    mediaType: "image" as const,
                  },
                  displayName: `${asset.id} · 产品原图对照`,
                })),
                ...(node.config.materials?.length
                  ? sampleMaterials.map((material) => ({
                      target: {
                        kind: "local_file" as const,
                        path: material.localPath,
                        mediaType: "image" as const,
                      },
                      displayName: material.displayName,
                    }))
                  : []),
              ];
              const qcResponse = await dependencies.promptClient.run({
                canvasId: CANVAS_ID,
                sourceNodeId: node.key,
                providerConnectionId: node.config.models.text.providerId,
                modelDefinitionId: node.config.models.text.modelDefinitionId,
                mode: definition?.qcMode ?? "knowledge_video_qc",
                task: "generate",
                userPrompt: `${qcPrompt(shot)}${node.config.commerce ? `\n产品保真核对：前 ${productReferences.length} 张图片为真实产品原图：${productReferences.map((asset, referenceIndex) => `图片${referenceIndex + 1}=${asset.id}（${asset.name}）`).join("；")}。后续五张为按时间顺序的成片采样帧。对照原图核验 Logo、色块、包装结构、比例、现有文字及使用动作；不可见细节不能宣称已验证，发现产品变形或身份改变应返工。产品已知资料：${node.config.commerce.productFacts}\n镜头产品锁定与引用：${shot.videoPrompt}` : ""}`,
                ...(visionImages.length ? { visionImages } : {}),
                ...(node.config.materials?.length ? {} : { multimodalInputs: sampleMaterials }),
              });
              const qc = parseKnowledgeVideoQc(qcResponse.optimizedPrompt);
              if (qc.result === "PASS") {
                commit((current) => ({
                  ...current,
                  shotRuns: {
                    ...current.shotRuns,
                    [shot.id]: {
                      ...current.shotRuns[shot.id]!,
                      qcStatus: "passed",
                      qcReport: qc.report,
                    },
                  },
                }));
                finished = true;
                continue;
              }
              if (qc.result === "NEEDS_DECISION") {
                commit((current) => ({
                  ...current,
                  phase: "awaiting_approval",
                  lastActivePhase: "qc",
                  decision: {
                    kind: "qc",
                    question: qc.question!,
                    recommendation: "接受上述差异，保留当前镜头并继续合成",
                  },
                  shotRuns: {
                    ...current.shotRuns,
                    [shot.id]: {
                      ...current.shotRuns[shot.id]!,
                      qcStatus: "failed",
                      qcReport: qc.report,
                    },
                  },
                }));
                progress("awaiting_approval", 78, "自动质检发现一项需要确认的问题。");
                return false as const;
              }
              run = checkpoint.shotRuns[shot.id]!;
              if (run.retryCount >= node.config.maxAutomaticRetries) {
                commit((current) => ({
                  ...current,
                  phase: "awaiting_approval",
                  lastActivePhase: "qc",
                  decision: {
                    kind: "qc",
                    question: `镜头 ${shot.sequence} 已达到 ${node.config.maxAutomaticRetries} 次自动返工上限，仍未通过质检：${qc.report}`,
                    recommendation:
                      "检查当前片段后明确选用；如需继续改进，请修改分镜并选择重做该镜头。",
                  },
                  shotRuns: {
                    ...current.shotRuns,
                    [shot.id]: {
                      ...current.shotRuns[shot.id]!,
                      qcStatus: "failed",
                      qcReport: qc.report,
                      repairPrompt: qc.repairPrompt,
                    },
                  },
                }));
                progress(
                  "awaiting_approval",
                  78,
                  "自动返工已达到上限，请检查并选用当前片段或明确重做。",
                );
                return false as const;
              }
              // A review may request another attempt only within the explicitly configured budget.
              commit((current) => ({
                ...current,
                phase: "generating",
                lastActivePhase: "generating",
                shotRuns: {
                  ...current.shotRuns,
                  [shot.id]: {
                    ...current.shotRuns[shot.id]!,
                    videoTaskId: null,
                    clipPath: null,
                    qcStatus: "pending",
                    qcReport: qc.report,
                    repairPrompt: qc.repairPrompt,
                    retryCount: current.shotRuns[shot.id]!.retryCount + 1,
                  },
                },
              }));
              completedShots -= 1;
              progress("generating", 66, `镜头 ${shot.sequence} 未通过质检，正在自动返工…`);
              try {
                await generateShot(shot);
              } catch (error: unknown) {
                throw new QcRegenerationError(error);
              }
              commit((current) => ({ ...current, phase: "qc", lastActivePhase: "qc" }));
              run = checkpoint.shotRuns[shot.id]!;
              qcAttempt = -1;
            } catch (error: unknown) {
              if (error instanceof QcRegenerationError) throw error.original;
              if (isAbortError(error)) throw error;
              qcInfrastructureFailure = errorMessage(error);
              if (qcAttempt < node.config.maxAutomaticRetries) {
                await dependencies.sleep(400, signal);
              }
            }
          }
          if (!finished) {
            commit((current) => ({
              ...current,
              phase: "awaiting_approval",
              lastActivePhase: "qc",
              decision: {
                kind: "qc",
                question: `镜头 ${shot.sequence} 无法完成视觉质检：${qcInfrastructureFailure}`,
                recommendation: "保留当前片段，按文件完整性结果继续合成",
              },
              shotRuns: {
                ...current.shotRuns,
                [shot.id]: {
                  ...current.shotRuns[shot.id]!,
                  qcStatus: "failed",
                  qcReport: `视觉质检未完成：${qcInfrastructureFailure}`,
                },
              },
            }));
            progress("awaiting_approval", 78, "视觉质检链路需要确认后继续。");
            return false as const;
          }
          progress(
            "qc",
            74 + Math.round(((index + 1) / checkpoint.shots.length) * 12),
            `已验收 ${index + 1}/${checkpoint.shots.length} 个片段。`,
          );
        };

        const composeDelivery = async () => {
          if (!requireMediaReview("composition")) return false as const;
          const clipPaths = checkpoint.shots.map((shot) => checkpoint.shotRuns[shot.id]?.clipPath);
          if (clipPaths.some((path) => !path)) throw new Error("部分视频片段尚未保存，无法合成。");
          let finalPath: string;
          if (checkpoint.finalPath && checkpoint.executionPlan?.review?.kind === "final") {
            finalPath = checkpoint.finalPath;
          } else if (clipPaths.length === 1 && !definition?.forceComposition) {
            finalPath = clipPaths[0]!;
          } else {
            commit((current) => ({ ...current, phase: "composing", lastActivePhase: "composing" }));
            progress("composing", 90, "正在顺序合成完整知识视频…");
            let compositionJobId = checkpoint.activeCompositionJobId;
            if (compositionJobId) {
              const existing = await readExistingComposition(
                dependencies.composerClient,
                compositionJobId,
                signal,
                dependencies.sleep,
              );
              if (existing?.status === "completed" && existing.finalPath) {
                finalPath = existing.finalPath;
              } else {
                if (
                  existing == null ||
                  existing.status === "failed" ||
                  existing.status === "cancelled"
                ) {
                  compositionJobId = null;
                  commit((current) => ({ ...current, activeCompositionJobId: null }));
                }
                if (compositionJobId) {
                  finalPath = await waitForComposition(
                    dependencies.composerClient,
                    compositionJobId,
                    signal,
                    dependencies.sleep,
                  );
                }
              }
            }
            if (!compositionJobId) {
              await request.beforeSideEffect?.();
              const job = definition?.startComposition
                ? await definition.startComposition(
                    context(),
                    checkpoint.shots.map((shot, index) => ({ shot, path: clipPaths[index]! })),
                  )
                : await dependencies.composerClient.startComposition(
                    clipPaths.map((path, index) => ({
                      key: checkpoint.shots[index]!.id,
                      name: `${String(index + 1).padStart(2, "0")}-${checkpoint.shots[index]!.section}`,
                      source: path!,
                    })),
                    `${workflowTitle}-完整交付`,
                  );
              commit((current) => ({ ...current, activeCompositionJobId: job.jobId }));
              if (signal.aborted) {
                await dependencies.composerClient.cancelJob(job.jobId).catch(() => undefined);
                throwIfAborted(signal);
              }
              finalPath = await waitForComposition(
                dependencies.composerClient,
                job.jobId,
                signal,
                dependencies.sleep,
              );
            }
          }
          await definition?.validateDelivery?.(context(), finalPath!);
          commit((current) => ({
            ...current,
            phase: "done",
            decision: null,
            activeCompositionJobId: null,
            finalPath,
            error: null,
          }));
          if (
            (node.config.comicDrama || definition?.requiresMediaReview) &&
            !requireMediaReview("final")
          )
            return false as const;
          progress("done", 100, `完整${workflowTitle}已生成并保存。`);
        };

        const executionSteps =
          checkpoint.executionPlan?.scope === "delivery"
            ? checkpoint.executionPlan.steps
            : createVideoWorkflowExecutionSteps(checkpoint);
        await executeWorkflowSteps(
          executionSteps,
          async (step) => {
            if (step.action === "assets") return prepareAssets();
            if (step.action === "cover") {
              await prepareCover();
              if (
                (node.config.comicDrama || definition?.requiresMediaReview) &&
                !requireMediaReview("assets")
              )
                return false;
              return;
            }
            if (step.action === "compose") return composeDelivery();
            const shot = checkpoint.shots.find((item) => item.id === step.shotId);
            if (!shot) throw new Error(`执行计划引用了不存在的镜头：${step.shotId ?? step.id}`);
            if (step.action === "video") {
              await generateShot(shot);
              if (
                (node.config.comicDrama || definition?.requiresMediaReview) &&
                orderedWorkflowShots(checkpoint)[0]?.id === shot.id
              ) {
                if ((await checkShot(shot)) === false) return false;
                if (!requireMediaReview("first_shot")) return false;
              }
              return;
            }
            if (step.action === "qc") return checkShot(shot);
            throw new Error(`执行计划步骤无法执行：${step.id}`);
          },
          { signal, concurrency: 2 },
        );

        return checkpoint;
      } catch (error: unknown) {
        const cancelled = isAbortError(error) || signal.aborted;
        const stoppedAt = persistedStage(checkpoint.phase, checkpoint.lastActivePhase);
        commit((current) => ({
          ...current,
          phase: cancelled ? "paused" : "failed",
          lastActivePhase: stoppedAt,
          error: cancelled
            ? "已停止本地轮询与后续步骤；供应商侧已提交的任务可能仍会完成。"
            : errorMessage(error),
        }));
        progress(
          cancelled ? "paused" : "failed",
          failedProgress(stoppedAt),
          cancelled ? "工作流已暂停。" : "工作流执行失败。",
          checkpoint.error,
        );
        return checkpoint;
      }
    },
  };
}
