import { stableJsonSignature } from "../../lib/workflowSignatures";
import {
  createWorkflowExecutionPlan,
  workflowExecutionInputSignature,
} from "./workflowExecutionPlan";
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
]);

function authoredPlan(value: unknown): unknown {
  return isRecord(value) ? without(value, ["id", "revision", "approval", "review"]) : value;
}

function authoredCheckpoint(value: unknown, includePlan = true): unknown {
  if (Array.isArray(value)) return value.map((child) => authoredCheckpoint(child, includePlan));
  if (!isRecord(value)) return value;
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

/** Only the workflow's editable content participates; canvas layout is outside this module. */
export function workflowVersionContentSignature(config: KnowledgeVideoWorkflowConfig): string {
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
  return stableJsonSignature(authored);
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
  checkpoint["mediaApprovals"] = {};
  checkpoint["approvedPlanRevision"] = null;
  if (isRecord(checkpoint["executionPlan"])) {
    checkpoint["executionPlan"] = { ...checkpoint["executionPlan"], approval: null };
  }
  if (isRecord(restored["executionPlan"])) {
    restored["executionPlan"] = { ...restored["executionPlan"], approval: null };
  }
  invalidateRestoredShotOutputs(checkpoint, current.checkpoint);
  if (
    checkpointContentSignature(historical.checkpoint) !==
    checkpointContentSignature(current.checkpoint)
  ) {
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
  const executionPlan =
    !inputsChanged && config.executionPlan?.scope === "workflow"
      ? { ...config.executionPlan, executionIntent: "resume" as const, approval: null }
      : createWorkflowExecutionPlan(asNode(config), inputsChanged ? "restart" : "resume");
  return clone({
    ...config,
    executionPlan,
    checkpoint: {
      ...config.checkpoint,
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
): WorkflowVersion {
  return { id: versionId(), parentId, createdAt: Date.now(), label, config: snapshot(config) };
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
  const initial = newVersion(config, null, "初始版本");
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
  let additions: WorkflowVersion[] | undefined;
  for (const version of incoming.versions) {
    const existing = byId.get(version.id);
    if (existing) {
      if (stableJsonSignature(existing) !== stableJsonSignature(version)) {
        throw new Error(`工作流版本 ${version.id} 存在不同内容，无法覆盖已有历史。`);
      }
      continue;
    }
    additions ??= [];
    additions.push(version);
    byId.set(version.id, version);
  }
  return {
    ...current,
    versions: additions ? [...current.versions, ...additions] : current.versions,
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

function appendVersion(
  history: WorkflowVersionHistory,
  config: KnowledgeVideoWorkflowConfig,
  label: string,
): WorkflowVersionHistory {
  const version = newVersion(config, history.currentVersionId, label);
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

/** Accept externally recorded checkpoints and explicit navigation without recording them twice. */
export function recordWorkflowVersion(
  previousConfig: KnowledgeVideoWorkflowConfig,
  nextConfig: KnowledgeVideoWorkflowConfig,
  label = "编辑工作流",
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
    workflowVersionContentSignature(previous) !== workflowVersionContentSignature(nextConfig);
  return {
    ...nextConfig,
    versionHistory: changed ? appendVersion(merged, nextConfig, label) : merged,
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
  else merged = appendVersion(merged, incomingConfig, "恢复工作流配置");
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
    versions: history.versions.map(({ id: versionId, parentId, createdAt, label }) => ({
      id: versionId,
      parentId,
      createdAt,
      label,
    })),
    redoVersionIds: history.versions
      .filter((version) => version.parentId === history.currentVersionId)
      .map((version) => version.id),
    pastCount,
    futureCount,
    canUndo: pastCount > 0,
    canRedo: futureCount > 0,
  };
}
