import { stableJsonSignature } from "../../lib/workflowSignatures";
import {
  createWorkflowExecutionPlan,
  workflowExecutionInputSignature,
} from "./workflowExecutionPlan";
import { createReelbenchCheckpoint } from "./reelbenchWorkflowModel";
import type {
  KnowledgeVideoWorkflowConfig,
  KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";
import { workflowConnectedTextBlock, workflowMaterialsSignature } from "./workflowMaterials";

export type WorkflowVersionConfig = Omit<KnowledgeVideoWorkflowConfig, "versionHistory">;

export interface WorkflowVersionSummary {
  readonly id: string;
  readonly parentId: string | null;
  readonly createdAt: number;
  readonly label: string;
  /** Working copies refresh this on every in-place rewrite; sealed versions keep it undefined. */
  readonly updatedAt?: number;
  /** True while this version is the mutable working copy of the stage in progress. */
  readonly open?: boolean;
}

export interface WorkflowVersion extends WorkflowVersionSummary {
  /** A workflow snapshot never contains its own history. */
  readonly config: WorkflowVersionConfig;
}

export interface WorkflowVersionHistory {
  readonly version: 1;
  readonly currentVersionId: string;
  readonly versions: readonly WorkflowVersion[];
  readonly preferredChildByVersion: Readonly<Record<string, string>>;
  /** Execution snapshots displaced by navigation; never used as a runnable checkpoint. */
  readonly runtimeArchives?: readonly WorkflowVersionConfig[];
}

export interface WorkflowVersionState {
  readonly currentVersionId: string;
  readonly versions: readonly WorkflowVersionSummary[];
  readonly redoVersionIds: readonly string[];
  readonly pastCount: number;
  readonly futureCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function without(value: Record<string, unknown>, fields: readonly string[]) {
  const copy = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
}

const RUNTIME_CONFIG_FIELDS = ["checkpoint", "historyRunId", "catalogResolved"] as const;

const CHECKPOINT_RUNTIME_FIELDS = new Set([
  "runId",
  "phase",
  "lastActivePhase",
  "approvedPlanRevision",
  "approval",
  "mediaApprovals",
  "shotRuns",
  "decision",
  "coverImagePath",
  "activeCompositionJobId",
  "finalPath",
  "error",
  "updatedAt",
  "createdAt",
  "taskId",
  "path",
  "imagePath",
  "renderJob",
  "downloadJobId",
  "videoPath",
  "delivery",
  "pending",
  "pendingStage",
  "completedStages",
  "planningComplete",
  "review",
  "businessReview",
  "contentReview",
  "passed",
  "repairCount",
  "approvedVersion",
  "approvals",
  "step",
  "history",
  "inputSignature",
  "materialsSignature",
  "alignment",
  "speech",
  "lipSyncVerification",
  "lipSyncFinalPath",
  "lipReviews",
]);

function authoredPlan(value: unknown): unknown {
  return isRecord(value) ? without(value, ["id", "revision", "approval", "review"]) : value;
}

function authoredCheckpoint(value: unknown, includePlan = true): unknown {
  if (Array.isArray(value)) return value.map((child) => authoredCheckpoint(child, includePlan));
  if (!isRecord(value)) return value;
  // The runner persists every measured cut, contact sheet, annotation batch and quality gate.
  // Only a completed annotation baseline or a human edit creates an authored version.
  if ("draft" in value && "approvedDraftSignature" in value && "manualRevision" in value)
    return {
      manualRevision: value["manualRevision"],
      completedDraftSignature: value["completedDraftSignature"] ?? null,
    };
  // Batch progress is runtime state. A 500-image job must not copy its complete plan
  // into a new authored version for every task update or image-review click.
  if (Array.isArray(value["rows"]) && "approvedThrough" in value)
    return { rows: authoredCheckpoint(value["rows"], includePlan) };
  if ("recipe" in value && "attempts" in value && "reviewNotes" in value)
    return { id: value["id"], index: value["index"], recipe: value["recipe"] };
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([field]) =>
          !CHECKPOINT_RUNTIME_FIELDS.has(field) && (includePlan || field !== "executionPlan"),
      )
      .map(([field, child]) => [
        field,
        field === "executionPlan" ? authoredPlan(child) : authoredCheckpoint(child, includePlan),
      ]),
  );
}

function checkpointContentSignature(value: unknown): string {
  return stableJsonSignature(authoredCheckpoint(value ?? null, false));
}

const RETAIN_EXECUTION_IDENTITY = new Set([
  "runId",
  "shotRuns",
  "inputSignature",
  "materialsSignature",
]);

/** Only reuse current completion/review state when its authored inputs still match. */
function checkpointForRestore(archived: unknown, current: unknown, parentMatches = true): unknown {
  if (Array.isArray(archived)) {
    const latest: readonly unknown[] = Array.isArray(current) ? current : [];
    return archived.map((item, index) => {
      const matching =
        isRecord(item) && typeof item["id"] === "string"
          ? latest.find((candidate) => isRecord(candidate) && candidate["id"] === item["id"])
          : latest[index];
      return checkpointForRestore(item, matching, parentMatches);
    });
  }
  if (!isRecord(archived)) return archived;
  const latest = isRecord(current) ? current : {};
  const matches =
    parentMatches && checkpointContentSignature(archived) === checkpointContentSignature(latest);
  if (matches && "recipe" in archived && "attempts" in archived && "reviewNotes" in archived)
    return clone(latest);
  const result: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(archived)) {
    result[field] =
      CHECKPOINT_RUNTIME_FIELDS.has(field) &&
      (matches || RETAIN_EXECUTION_IDENTITY.has(field)) &&
      latest[field] !== undefined
        ? latest[field]
        : CHECKPOINT_RUNTIME_FIELDS.has(field)
          ? value
          : checkpointForRestore(value, latest[field], matches);
  }
  for (const [field, value] of Object.entries(latest)) {
    if (CHECKPOINT_RUNTIME_FIELDS.has(field) && (matches || RETAIN_EXECUTION_IDENTITY.has(field)))
      result[field] = value;
  }
  if (!matches) {
    for (const field of [
      "decision",
      "review",
      "businessReview",
      "contentReview",
      "renderJob",
      "delivery",
      "pending",
      "pendingStage",
    ]) {
      if (field in result) result[field] = null;
    }
    if ("passed" in result) result["passed"] = false;
    if ("repairCount" in result) result["repairCount"] = 0;
    // A cover job belongs to its exact plan; unrelated paid jobs remain in runtimeArchives.
    if ("plan" in result && "imagePath" in result) {
      result["taskId"] = null;
      result["imagePath"] = null;
      result["finalPath"] = null;
    }
    if ("step" in result && "analysis" in result) {
      result["step"] = result["analysis"]
        ? "review"
        : result["evidence"]
          ? "analysis"
          : result["videoPath"]
            ? "sampling"
            : "download";
    }
  }
  if ("approval" in result) result["approval"] = null;
  if ("mediaApprovals" in result) result["mediaApprovals"] = {};
  if ("approvedPlanRevision" in result) result["approvedPlanRevision"] = null;
  if ("approvedVersion" in result) delete result["approvedVersion"];
  if (Array.isArray(result["rows"]) && "approvedThrough" in result) {
    result["approvedThrough"] = 0;
    result["batchReviewPending"] = true;
  }
  return result;
}

function invalidateRestoredShotOutputs(
  checkpoint: Record<string, unknown>,
  current: unknown,
): void {
  const shots: readonly unknown[] = Array.isArray(checkpoint["shots"]) ? checkpoint["shots"] : [];
  const currentShots: readonly unknown[] =
    isRecord(current) && Array.isArray(current["shots"]) ? current["shots"] : [];
  if (stableJsonSignature(shots) === stableJsonSignature(currentShots)) return;
  const previousById = new Map(currentShots.filter(isRecord).map((shot) => [shot["id"], shot]));
  const runs = isRecord(checkpoint["shotRuns"]) ? { ...checkpoint["shotRuns"] } : {};
  let changedMedia = false;
  for (const shot of shots) {
    if (!isRecord(shot) || typeof shot["id"] !== "string") continue;
    const previous = previousById.get(shot["id"]);
    if (previous && stableJsonSignature(shot) === stableJsonSignature(previous)) continue;
    const run = runs[shot["id"]];
    runs[shot["id"]] = {
      ...(isRecord(run) ? run : { shotId: shot["id"], qcStatus: "pending", retryCount: 0 }),
      promptEdited: true,
    };
    changedMedia = true;
  }
  // Keep paid task identities and files until an explicitly approved replacement is submitted.
  // The runner propagates promptEdited through dependencies before regenerating affected clips.
  checkpoint["shotRuns"] = runs;
  checkpoint["finalPath"] = null;
  checkpoint["activeCompositionJobId"] = null;
  checkpoint["phase"] = "paused";
  checkpoint["lastActivePhase"] = changedMedia ? "generating" : "composing";
}

/**
 * 版本链记录的是「生成阶段」，不是「每一次编辑」。
 *
 * 参数、模式、文案或素材的微调只改变当前阶段的输入，就地改写当前工作副本即可；
 * 只有工作流真正跨进下一个生成阶段（或用户重开一次制作）时才封版建档。
 * 这样回退一次就回到一个有意义的阶段起点，而不是回到某个中间参数。
 */
export type WorkflowVersionStage = "draft" | "planned" | "generating" | "qc" | "composing" | "done";

const WORKFLOW_VERSION_STAGE_RANK: Readonly<Record<WorkflowVersionStage, number>> = {
  draft: 0,
  planned: 1,
  generating: 2,
  qc: 3,
  composing: 4,
  done: 5,
};

const WORKFLOW_VERSION_STAGE_LABELS: Readonly<Record<WorkflowVersionStage, string>> = {
  draft: "编辑草稿",
  planned: "已生成计划",
  generating: "生成阶段",
  qc: "质检阶段",
  composing: "合成阶段",
  done: "制作完成",
};

/** 计划存在的证据；阶段字段才是主判据，这里只兜底「已出方案但阶段回到 idle」的载体。 */
function hasWorkflowPlan(config: KnowledgeVideoWorkflowConfig): boolean {
  if (config.executionPlan) return true;
  const checkpoint = config.checkpoint;
  if (
    checkpoint.script.trim() ||
    checkpoint.storyboard.trim() ||
    checkpoint.manifest.trim() ||
    checkpoint.shots.length > 0 ||
    checkpoint.planRevision > 0
  )
    return true;
  if (
    checkpoint.productScene?.rows.length ||
    checkpoint.remotion?.plan ||
    checkpoint.reverseVideo?.analysis ||
    checkpoint.reelbench?.draft ||
    checkpoint.film?.artifacts.length ||
    checkpoint.xhsCover?.plan
  )
    return true;
  if (Object.keys(checkpoint.musicVideo?.stages ?? {}).length) return true;
  if (Object.keys(checkpoint.commerce?.stages ?? {}).length) return true;
  return Boolean(
    checkpoint.comicDrama?.episodes.some((episode) => Object.keys(episode.stages).length),
  );
}

/** 暂停与失败不是新的生成阶段：沿用真实停留过的那一个阶段。 */
function pausedWorkflowStage(config: KnowledgeVideoWorkflowConfig): WorkflowVersionStage {
  switch (config.checkpoint.lastActivePhase) {
    case "composing":
      return "composing";
    case "qc":
      return "qc";
    case "generating":
      return "generating";
    case "planning":
      return "planned";
    case null:
      return hasWorkflowPlan(config) ? "planned" : "draft";
  }
}

/** 当前所处的生成阶段；暂停与失败保留真实停留阶段，本身不算阶段推进。 */
export function workflowVersionStage(config: KnowledgeVideoWorkflowConfig): WorkflowVersionStage {
  switch (config.checkpoint.phase) {
    case "composing":
      return "composing";
    case "qc":
      return "qc";
    case "generating":
      return "generating";
    case "planning":
    case "awaiting_approval":
      return "planned";
    case "done":
      return "done";
    case "paused":
    case "failed":
      return pausedWorkflowStage(config);
    case "idle":
      return hasWorkflowPlan(config) ? "planned" : "draft";
  }
}

/** 输入身份：只有它变了，阶段回退才代表「上一轮成果必须留档」。 */
function workflowInputSignature(config: KnowledgeVideoWorkflowConfig): string {
  return workflowExecutionInputSignature(asNode({ ...config, brief: originalBrief(config) }));
}

// Config objects are replaced immutably across the app, so one reference's signature
// never changes. Publishing a checkpoint recomputes this signature several times
// (runner publish, canvas store, history enqueue) over a plan that can hold 500 rows;
// the cache turns the repeats into lookups instead of full-tree stringify passes.
const contentSignatureCache = new WeakMap<object, string>();

/** Only the workflow's editable content participates; canvas layout is outside this module. */
export function workflowVersionContentSignature(config: KnowledgeVideoWorkflowConfig): string {
  const cached = contentSignatureCache.get(config);
  if (cached !== undefined) return cached;
  const authored = without(config as unknown as Record<string, unknown>, [
    ...RUNTIME_CONFIG_FIELDS,
    "versionHistory",
    "connectedMaterials",
    "connectedTexts",
  ]);
  authored["brief"] = originalBrief(config);
  authored["historicalReferences"] = workflowMaterialsSignature({ ...config, materials: [] });
  authored["checkpoint"] = authoredCheckpoint(config.checkpoint);
  if (config.executionPlan) authored["executionPlan"] = authoredPlan(config.executionPlan);
  const signature = stableJsonSignature(authored);
  contentSignatureCache.set(config, signature);
  return signature;
}

// Sealed version records are created once and never mutated; working copies are replaced by a
// new record object instead of being written into. Full-JSON signatures (used to detect
// conflicting history merges) are therefore cacheable per reference.
const versionSignatureCache = new WeakMap<object, string>();

function versionSignature(value: WorkflowVersion): string {
  const cached = versionSignatureCache.get(value);
  if (cached !== undefined) return cached;
  const signature = stableJsonSignature(value);
  versionSignatureCache.set(value, signature);
  return signature;
}

function originalBrief(config: KnowledgeVideoWorkflowConfig): string {
  const block = workflowConnectedTextBlock(config);
  return block && config.brief.endsWith(block)
    ? config.brief.slice(0, -block.length).trimEnd()
    : config.brief;
}

function snapshot(config: KnowledgeVideoWorkflowConfig): WorkflowVersionConfig {
  return clone(
    without(config as unknown as Record<string, unknown>, ["versionHistory"]),
  ) as unknown as WorkflowVersionConfig;
}

function mergeRuntimeArchives(
  current: readonly WorkflowVersionConfig[] = [],
  incoming: readonly WorkflowVersionConfig[] = [],
): readonly WorkflowVersionConfig[] {
  if (!incoming.length) return current;
  const known = new Set(current.map(stableJsonSignature));
  const additions = incoming.filter((item) => {
    const signature = stableJsonSignature(item);
    if (known.has(signature)) return false;
    known.add(signature);
    return true;
  });
  return additions.length ? [...current, ...additions] : current;
}

function hasExecutionIdentity(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExecutionIdentity);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([field, child]) =>
      ([
        "historyRunId",
        "runId",
        "taskId",
        "videoTaskId",
        "downloadJobId",
        "activeCompositionJobId",
      ].includes(field) &&
        typeof child === "string" &&
        child.length > 0) ||
      (field === "renderJob" && isRecord(child) && typeof child["id"] === "string") ||
      hasExecutionIdentity(child),
  );
}

function archiveExecution(
  history: WorkflowVersionHistory,
  config: KnowledgeVideoWorkflowConfig,
): WorkflowVersionHistory {
  const content = snapshot(config);
  if (!hasExecutionIdentity(content)) return history;
  const runtimeArchives = mergeRuntimeArchives(history.runtimeArchives, [content]);
  return runtimeArchives === history.runtimeArchives ? history : { ...history, runtimeArchives };
}

function asNode(config: KnowledgeVideoWorkflowConfig): KnowledgeVideoWorkflowNodeData {
  return { key: "workflow-version", kind: "knowledge_video_workflow", x: 0, y: 0, config };
}

function clearAudioEvidence(checkpoint: Record<string, unknown>): void {
  // Keep authored dialogue and lyrics, but never reuse paid/audio review evidence
  // after restoring different content or inputs.
  delete checkpoint["speech"];
  if (isRecord(checkpoint["comicDrama"])) {
    checkpoint["comicDrama"] = without(checkpoint["comicDrama"], ["speech"]);
  }
  if (isRecord(checkpoint["musicVideo"])) {
    checkpoint["musicVideo"] = without(checkpoint["musicVideo"], [
      "speech",
      "alignment",
      "lipSyncVerification",
      "lipSyncFinalPath",
      "lipReviews",
    ]);
  }
}

function restoreConfiguration(
  current: KnowledgeVideoWorkflowConfig,
  historical: WorkflowVersionConfig,
): KnowledgeVideoWorkflowConfig {
  const restored = snapshot(historical) as unknown as Record<string, unknown>;
  const latest = current as unknown as Record<string, unknown>;
  for (const field of RUNTIME_CONFIG_FIELDS) {
    if (latest[field] !== undefined) restored[field] = clone(latest[field]);
  }
  const checkpoint = checkpointForRestore(historical.checkpoint, current.checkpoint) as Record<
    string,
    unknown
  >;
  const creativeContentChanged =
    checkpointContentSignature(historical.checkpoint) !==
    checkpointContentSignature(current.checkpoint);
  if (creativeContentChanged) clearAudioEvidence(checkpoint);
  let reelbenchRunMismatch = false;
  if (isRecord(checkpoint["reelbench"])) {
    const reelbench = { ...checkpoint["reelbench"] };
    const draft = isRecord(reelbench["draft"]) ? reelbench["draft"] : null;
    const historicalReelbench = isRecord(historical.checkpoint?.reelbench)
      ? historical.checkpoint.reelbench
      : null;
    const historicalDraft =
      historicalReelbench && isRecord(historicalReelbench["draft"])
        ? historicalReelbench["draft"]
        : null;
    if (draft && historicalDraft?.["runId"] !== checkpoint["runId"]) {
      // Restored draft and retained execution identity must never point to different runs.
      reelbenchRunMismatch = true;
      reelbench["draft"] = null;
      reelbench["completedDraftSignature"] = null;
      reelbench["videoPath"] = null;
      reelbench["downloadJobId"] = null;
      reelbench["inputSignature"] = null;
      checkpoint["runId"] = null;
      delete restored["historyRunId"];
    }
    const usableDraft = isRecord(reelbench["draft"]) ? reelbench["draft"] : null;
    const shots = usableDraft && Array.isArray(usableDraft["shots"]) ? usableDraft["shots"] : [];
    const annotated =
      shots.length > 0 &&
      shots.every(
        (shot) =>
          isRecord(shot) &&
          Boolean(
            shot["size"] &&
            shot["category"] &&
            shot["camera"] &&
            typeof shot["frame"] === "string" &&
            shot["frame"].trim(),
          ),
      );
    Object.assign(reelbench, {
      validation: null,
      validatedDraftSignature: null,
      approvedDraftSignature: null,
      reportJsonPath: null,
      reportMarkdownPath: null,
      reportHtmlPath: null,
      syncVideoPath: null,
      step: usableDraft
        ? annotated
          ? "validate"
          : "annotate"
        : reelbench["videoPath"]
          ? "seed"
          : "source",
    });
    checkpoint["reelbench"] = reelbench;
    checkpoint["finalPath"] = null;
    checkpoint["phase"] = "paused";
    checkpoint["lastActivePhase"] = "qc";
    checkpoint["error"] = null;
  }
  checkpoint["mediaApprovals"] = {};
  checkpoint["approvedPlanRevision"] = null;
  if (isRecord(checkpoint["executionPlan"])) {
    checkpoint["executionPlan"] = { ...checkpoint["executionPlan"], approval: null };
  }
  if (isRecord(restored["executionPlan"])) {
    restored["executionPlan"] = { ...restored["executionPlan"], approval: null };
  }
  invalidateRestoredShotOutputs(checkpoint, current.checkpoint);
  if (creativeContentChanged) {
    checkpoint["phase"] = "paused";
    checkpoint["finalPath"] = null;
    checkpoint["activeCompositionJobId"] = null;
    checkpoint["error"] = null;
  }
  if (["planning", "generating", "qc", "composing"].includes(String(checkpoint["phase"]))) {
    checkpoint["lastActivePhase"] = checkpoint["phase"];
    checkpoint["phase"] = "paused";
  }
  restored["checkpoint"] = checkpoint;
  const config = restored as unknown as KnowledgeVideoWorkflowConfig;
  const inputsChanged =
    workflowExecutionInputSignature(asNode({ ...config, brief: originalBrief(config) })) !==
    workflowExecutionInputSignature(asNode({ ...current, brief: originalBrief(current) }));
  if (inputsChanged && !creativeContentChanged) clearAudioEvidence(checkpoint);
  const restartReelbench = Boolean(config.reelbench && inputsChanged);
  const executionPlan =
    !inputsChanged && !reelbenchRunMismatch && config.executionPlan?.scope === "workflow"
      ? { ...config.executionPlan, executionIntent: "resume" as const, approval: null }
      : createWorkflowExecutionPlan(
          asNode(config),
          inputsChanged || reelbenchRunMismatch ? "restart" : "resume",
        );
  const outputConfig = { ...config };
  if (restartReelbench) delete outputConfig.historyRunId;
  return clone({
    ...outputConfig,
    executionPlan,
    checkpoint: {
      ...config.checkpoint,
      ...(restartReelbench ? { runId: null, reelbench: createReelbenchCheckpoint() } : {}),
      executionPlan,
      ...(inputsChanged
        ? { phase: "awaiting_approval" as const, finalPath: null, activeCompositionJobId: null }
        : {}),
    },
  });
}

function versionId(): string {
  return `wv-${crypto.randomUUID()}`;
}

function newVersion(
  config: KnowledgeVideoWorkflowConfig,
  parentId: string | null,
  label: string,
  open: boolean,
): WorkflowVersion {
  return {
    id: versionId(),
    parentId,
    createdAt: Date.now(),
    label,
    ...(open ? { open: true } : {}),
    config: snapshot(config),
  };
}

/** 未封版的工作副本可以被同名改写；封版版本永远保持原样。 */
function isOpenVersion(version: WorkflowVersion | undefined): boolean {
  return version?.open === true;
}

function replaceVersion(
  history: WorkflowVersionHistory,
  id: string,
  next: WorkflowVersion,
): WorkflowVersionHistory {
  return {
    ...history,
    versions: history.versions.map((version) => (version.id === id ? next : version)),
  };
}

/** 就地改写当前工作副本：参数、模式、文案微调都在这里落账，不新增版本。 */
function amendVersion(
  history: WorkflowVersionHistory,
  config: KnowledgeVideoWorkflowConfig,
): WorkflowVersionHistory {
  const current = history.versions.find((version) => version.id === history.currentVersionId);
  if (!current) throw new Error(`找不到工作流版本：${history.currentVersionId}`);
  return replaceVersion(history, current.id, {
    ...current,
    open: true,
    updatedAt: Date.now(),
    config: snapshot(config),
  });
}

/** 阶段推进前先封版：工作副本保留为上一阶段的起点快照。 */
function sealVersion(history: WorkflowVersionHistory, config: KnowledgeVideoWorkflowConfig) {
  const current = history.versions.find((version) => version.id === history.currentVersionId);
  if (!current) throw new Error(`找不到工作流版本：${history.currentVersionId}`);
  if (!isOpenVersion(current)) return history;
  const sealed: WorkflowVersion = { ...current, config: snapshot(config) };
  delete (sealed as { open?: boolean }).open;
  return replaceVersion(history, current.id, sealed);
}

function appendVersion(
  history: WorkflowVersionHistory,
  config: KnowledgeVideoWorkflowConfig,
  label: string,
  open: boolean,
): WorkflowVersionHistory {
  const version = newVersion(config, history.currentVersionId, label, open);
  return {
    ...history,
    currentVersionId: version.id,
    versions: [...history.versions, version],
    preferredChildByVersion: {
      ...history.preferredChildByVersion,
      [history.currentVersionId]: version.id,
    },
  };
}

function assertHistory(value: unknown): asserts value is WorkflowVersionHistory {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !Array.isArray(value["versions"]) ||
    !value["versions"].length ||
    typeof value["currentVersionId"] !== "string" ||
    !isRecord(value["preferredChildByVersion"])
  ) {
    throw new Error("工作流版本历史无效，已保留原有记录。");
  }
  const known = new Map<string, string | null>();
  for (const raw of value["versions"] as readonly unknown[]) {
    if (
      !isRecord(raw) ||
      typeof raw["id"] !== "string" ||
      !raw["id"] ||
      known.has(raw["id"]) ||
      typeof raw["createdAt"] !== "number" ||
      !Number.isFinite(raw["createdAt"]) ||
      typeof raw["label"] !== "string"
    ) {
      throw new Error("工作流版本身份或元数据无效。");
    }
    const parentId = raw["parentId"];
    if (parentId !== null && (typeof parentId !== "string" || !known.has(parentId))) {
      throw new Error("工作流版本链包含循环或缺失的父版本。");
    }
    const open = raw["open"];
    const updatedAt = raw["updatedAt"];
    if (
      (open !== undefined && typeof open !== "boolean") ||
      (updatedAt !== undefined && (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)))
    ) {
      throw new Error("工作流版本身份或元数据无效。");
    }
    const content = raw["config"];
    if (
      !isRecord(content) ||
      "versionHistory" in content ||
      typeof content["brief"] !== "string" ||
      !isRecord(content["models"]) ||
      !isRecord(content["checkpoint"])
    ) {
      throw new Error("工作流版本内容无效，版本快照不能包含嵌套历史。");
    }
    known.set(raw["id"], parentId);
  }
  if (!known.has(value["currentVersionId"])) throw new Error("工作流当前版本不存在。");
  for (const [parent, child] of Object.entries(value["preferredChildByVersion"])) {
    if (typeof child !== "string" || !known.has(parent) || known.get(child) !== parent) {
      throw new Error("工作流重做分支无效。");
    }
  }
  if (value["runtimeArchives"] !== undefined) {
    if (
      !Array.isArray(value["runtimeArchives"]) ||
      value["runtimeArchives"].some(
        (content: unknown) =>
          !isRecord(content) ||
          "versionHistory" in content ||
          typeof content["brief"] !== "string" ||
          !isRecord(content["checkpoint"]),
      )
    )
      throw new Error("工作流任务归档无效，执行快照不能包含嵌套历史。");
  }
}

function historyOf(config: KnowledgeVideoWorkflowConfig): WorkflowVersionHistory | undefined {
  if (config.versionHistory === undefined) return undefined;
  assertHistory(config.versionHistory);
  return config.versionHistory;
}

export function initializeWorkflowVersions(
  config: KnowledgeVideoWorkflowConfig,
): KnowledgeVideoWorkflowConfig {
  if (historyOf(config)) return config;
  // 初始版本就是一个工作副本：生成开始前的所有参数/模式调整都改写在它身上。
  const initial = newVersion(config, null, "初始版本", true);
  return {
    ...config,
    versionHistory: {
      version: 1,
      currentVersionId: initial.id,
      versions: [initial],
      preferredChildByVersion: {},
    },
  };
}

function mergeHistories(
  current: WorkflowVersionHistory,
  incoming: WorkflowVersionHistory | undefined,
): WorkflowVersionHistory {
  if (!incoming || incoming === current) return current;
  const byId = new Map(current.versions.map((version) => [version.id, version]));
  let merged = current;
  for (const version of incoming.versions) {
    const existing = byId.get(version.id);
    if (existing) {
      if (versionSignature(existing) === versionSignature(version)) continue;
      // 工作副本本来就会被就地改写：画布旧快照、撤销栈与历史库里的同名副本允许不一致，
      // 取调用方正在生效的这一份（返回值永远由 nextConfig 派生）。封版版本仍必须逐字一致，
      // 否则说明历史被外部改坏，宁可报错也不静默覆盖用户的版本记录。
      if (isOpenVersion(existing) || isOpenVersion(version)) {
        merged = replaceVersion(merged, version.id, version);
        byId.set(version.id, version);
        continue;
      }
      throw new Error(`工作流版本 ${version.id} 存在不同内容，无法覆盖已有历史。`);
    }
    merged = {
      ...merged,
      versions: [...merged.versions, version],
    };
    byId.set(version.id, version);
  }
  return {
    ...merged,
    ...(current.runtimeArchives?.length || incoming.runtimeArchives?.length
      ? { runtimeArchives: mergeRuntimeArchives(current.runtimeArchives, incoming.runtimeArchives) }
      : {}),
    preferredChildByVersion: {
      ...current.preferredChildByVersion,
      ...incoming.preferredChildByVersion,
    },
  };
}

function moveCursor(history: WorkflowVersionHistory, id: string): WorkflowVersionHistory {
  const byId = new Map(history.versions.map((version) => [version.id, version]));
  if (!byId.has(id)) throw new Error(`找不到工作流版本：${id}`);
  const preferred = { ...history.preferredChildByVersion };
  for (const start of [history.currentVersionId, id]) {
    let cursor = byId.get(start);
    while (cursor?.parentId) {
      preferred[cursor.parentId] = cursor.id;
      cursor = byId.get(cursor.parentId);
    }
  }
  return { ...history, currentVersionId: id, preferredChildByVersion: preferred };
}

function matchesVersion(
  current: KnowledgeVideoWorkflowConfig,
  incoming: KnowledgeVideoWorkflowConfig,
  version: WorkflowVersion,
): boolean {
  const signature = workflowVersionContentSignature(incoming);
  return (
    signature === workflowVersionContentSignature(version.config) ||
    signature === workflowVersionContentSignature(restoreConfiguration(current, version.config))
  );
}

/**
 * 只有两种情况需要新建版本：
 * 1. 跨进下一个生成阶段（规划 → 生成 → 质检 → 合成 → 完成）；
 * 2. 输入变更导致阶段回退——例如改了参数让已完成的计划作废，上一轮成果必须留档。
 * 其余变化（参数、模式、文案、素材、重开制作、同一阶段内的进度）都就地改写当前工作副本，
 * 或由封版规则自然派生出一个新的工作副本。这样一次回退就是回到一个生成阶段的起点，
 * 而不是回到某个中间参数。
 */
function needsMilestone(
  tip: WorkflowVersion,
  previous: KnowledgeVideoWorkflowConfig,
  next: KnowledgeVideoWorkflowConfig,
): boolean {
  const tipStage = workflowVersionStage(tip.config);
  const nextStage = workflowVersionStage(next);
  if (WORKFLOW_VERSION_STAGE_RANK[nextStage] > WORKFLOW_VERSION_STAGE_RANK[tipStage]) return true;
  return Boolean(
    WORKFLOW_VERSION_STAGE_RANK[tipStage] >= WORKFLOW_VERSION_STAGE_RANK.generating &&
    WORKFLOW_VERSION_STAGE_RANK[nextStage] < WORKFLOW_VERSION_STAGE_RANK[tipStage] &&
    workflowInputSignature(previous) !== workflowInputSignature(next),
  );
}

/** Accept externally recorded checkpoints and explicit navigation without recording them twice. */
export function recordWorkflowVersion(
  previousConfig: KnowledgeVideoWorkflowConfig,
  nextConfig: KnowledgeVideoWorkflowConfig,
  label?: string,
): KnowledgeVideoWorkflowConfig {
  const previous = initializeWorkflowVersions(previousConfig);
  const history = previous.versionHistory!;
  const incomingHistory = historyOf(nextConfig);
  const merged = mergeHistories(history, incomingHistory);
  if (
    incomingHistory &&
    incomingHistory.currentVersionId !== history.currentVersionId &&
    incomingHistory.versions.some((version) => version.id === history.currentVersionId)
  ) {
    const version = incomingHistory.versions.find(
      (item) => item.id === incomingHistory.currentVersionId,
    )!;
    if (matchesVersion(previous, nextConfig, version)) {
      return { ...nextConfig, versionHistory: moveCursor(merged, version.id) };
    }
  }
  const changed =
    workflowVersionContentSignature(previous) !== workflowVersionContentSignature(nextConfig) ||
    workflowVersionStage(previous) !== workflowVersionStage(nextConfig);
  if (!changed) return { ...nextConfig, versionHistory: merged };
  const tip = merged.versions.find((version) => version.id === merged.currentVersionId);
  if (!tip) throw new Error(`找不到工作流版本：${merged.currentVersionId}`);
  if (needsMilestone(tip, previous, nextConfig)) {
    const stage = workflowVersionStage(nextConfig);
    return {
      ...nextConfig,
      versionHistory: appendVersion(
        sealVersion(merged, previous),
        nextConfig,
        label ?? WORKFLOW_VERSION_STAGE_LABELS[stage],
        false,
      ),
    };
  }
  return {
    ...nextConfig,
    versionHistory: isOpenVersion(tip)
      ? amendVersion(merged, nextConfig)
      : appendVersion(merged, nextConfig, label ?? "编辑工作流", true),
  };
}

export function restoreWorkflowVersion(
  config: KnowledgeVideoWorkflowConfig,
  id: string,
): KnowledgeVideoWorkflowConfig {
  const initialized = initializeWorkflowVersions(config);
  const history = initialized.versionHistory!;
  const target = history.versions.find((version) => version.id === id);
  if (!target) throw new Error(`找不到工作流版本：${id}`);
  if (history.currentVersionId === id) return initialized;
  return {
    ...restoreConfiguration(initialized, target.config),
    versionHistory: moveCursor(archiveExecution(history, initialized), id),
  };
}

export function undoWorkflowVersion(
  config: KnowledgeVideoWorkflowConfig,
): KnowledgeVideoWorkflowConfig {
  const history = historyOf(config);
  if (!history) return config;
  const parent = history.versions.find(
    (version) => version.id === history.currentVersionId,
  )?.parentId;
  return parent ? restoreWorkflowVersion(config, parent) : config;
}

export function redoWorkflowVersion(
  config: KnowledgeVideoWorkflowConfig,
  id?: string,
): KnowledgeVideoWorkflowConfig {
  const history = historyOf(config);
  if (!history) return config;
  const nextId = id ?? history.preferredChildByVersion[history.currentVersionId];
  if (!nextId) return config;
  if (
    !history.versions.some(
      (version) => version.id === nextId && version.parentId === history.currentVersionId,
    )
  ) {
    throw new Error("所选工作流版本不属于当前版本的重做分支。");
  }
  return restoreWorkflowVersion(config, nextId);
}

/** Canvas navigation may restore a workflow's content, but never discard its newer branches. */
export function mergeWorkflowVersionHistory(
  currentConfig: KnowledgeVideoWorkflowConfig,
  incomingConfig: KnowledgeVideoWorkflowConfig,
): KnowledgeVideoWorkflowConfig {
  const current = initializeWorkflowVersions(currentConfig);
  const incomingHistory = historyOf(incomingConfig);
  let merged = mergeHistories(current.versionHistory!, incomingHistory);
  const incomingCursor = incomingHistory?.versions.find(
    (version) => version.id === incomingHistory.currentVersionId,
  );
  const matching =
    incomingCursor && matchesVersion(current, incomingConfig, incomingCursor)
      ? incomingCursor
      : [...merged.versions]
          .reverse()
          .find(
            (version) =>
              workflowVersionContentSignature(version.config) ===
              workflowVersionContentSignature(incomingConfig),
          );
  if (matching) merged = moveCursor(merged, matching.id);
  // 画布上生效的内容还没有任何版本承载它：补一个工作副本，后续编辑继续改写它。
  else merged = appendVersion(merged, incomingConfig, "恢复工作流配置", true);
  const contentMatches =
    workflowVersionContentSignature(current) === workflowVersionContentSignature(incomingConfig);
  if (!contentMatches) merged = archiveExecution(merged, current);
  const content = contentMatches
    ? current
    : restoreConfiguration(current, snapshot(incomingConfig));
  return { ...content, versionHistory: merged };
}

export function workflowVersionState(config: KnowledgeVideoWorkflowConfig): WorkflowVersionState {
  const history = historyOf(config);
  if (!history)
    return {
      currentVersionId: "",
      versions: [],
      redoVersionIds: [],
      pastCount: 0,
      futureCount: 0,
      canUndo: false,
      canRedo: false,
    };
  const byId = new Map(history.versions.map((version) => [version.id, version]));
  let pastCount = 0;
  let cursor = byId.get(history.currentVersionId);
  while (cursor?.parentId) {
    pastCount += 1;
    cursor = byId.get(cursor.parentId);
  }
  let futureCount = 0;
  let id = history.currentVersionId;
  while (history.preferredChildByVersion[id]) {
    id = history.preferredChildByVersion[id]!;
    futureCount += 1;
  }
  return {
    currentVersionId: history.currentVersionId,
    versions: history.versions.map(
      ({ id: versionId, parentId, createdAt, label, updatedAt, open }) => ({
        id: versionId,
        parentId,
        createdAt,
        label,
        ...(updatedAt === undefined ? {} : { updatedAt }),
        ...(open ? { open: true } : {}),
      }),
    ),
    redoVersionIds: history.versions
      .filter((version) => version.parentId === history.currentVersionId)
      .map((version) => version.id),
    pastCount,
    futureCount,
    canUndo: pastCount > 0,
    canRedo: futureCount > 0,
  };
}
