import type {
  WorkflowVersionConfig,
  WorkflowVersionHistory,
} from "../features/workspace/workflowVersionHistory";

type JsonRecord = Record<string, unknown>;
type Delta =
  | { readonly kind: "replace"; readonly value: unknown }
  | {
      readonly kind: "object";
      readonly changes: Readonly<Record<string, Delta>>;
      readonly removed: readonly string[];
    }
  | {
      readonly kind: "array";
      readonly length: number;
      readonly changes: readonly (readonly [number, Delta])[];
    };
type Content =
  | { readonly kind: "full"; readonly value: WorkflowVersionConfig }
  | { readonly kind: "delta"; readonly base: number; readonly patch: Delta };
interface StoredHistory {
  readonly version: 2;
  readonly currentVersionId: string;
  readonly versions: readonly (Omit<WorkflowVersionHistory["versions"][number], "config"> & {
    readonly content: number;
  })[];
  readonly preferredChildByVersion: Readonly<Record<string, string>>;
  readonly runtimeArchives?: readonly number[];
  readonly contents: readonly Content[];
}

const CHECKPOINT_INTERVAL = 16;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const encoded = new WeakMap<WorkflowVersionHistory, StoredHistory>();
const decoded = new WeakMap<object, WorkflowVersionHistory>();
const deltaCache = new WeakMap<object, WeakMap<object, Delta | null>>();
const sizes = new WeakMap<object, number>();
const encoder = new TextEncoder();
const record = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = () => new Error("工作流增量版本记录损坏或不完整，请保留原存档并从备份恢复。");
function checkBudget(bytes: number) {
  if (bytes > MAX_EXPANDED_BYTES)
    throw new Error("工作流版本恢复后超过256MiB，请保留存档并拆分单个工作流内容。");
}
function put(target: JsonRecord, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
function size(value: object): number {
  const cached = sizes.get(value);
  if (cached !== undefined) return cached;
  const itemSize = (item: unknown): number => {
    if (item !== null && typeof item === "object") return size(item);
    return encoder.encode(JSON.stringify(item) ?? "null").byteLength;
  };
  // Count shared JSON subtrees without constructing a fully expanded history string.
  let bytes = 2;
  if (Array.isArray(value)) {
    bytes += Math.max(0, value.length - 1);
    for (const item of value) bytes += itemSize(item);
  } else {
    let fields = 0;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (fields++) bytes += 1;
      bytes += encoder.encode(JSON.stringify(key)).byteLength + 1 + itemSize(item);
    }
  }
  sizes.set(value, bytes);
  return bytes;
}

function difference(base: unknown, next: unknown): Delta | null {
  if (base === next) return null;
  if (Array.isArray(base) && Array.isArray(next)) {
    const before: readonly unknown[] = base;
    const after: readonly unknown[] = next;
    const changes: [number, Delta][] = [];
    for (let index = 0; index < after.length; index += 1) {
      const patch =
        index < before.length
          ? difference(before[index], after[index])
          : { kind: "replace" as const, value: after[index] };
      if (patch) changes.push([index, patch]);
    }
    return changes.length || base.length !== next.length
      ? { kind: "array", length: next.length, changes }
      : null;
  }
  if (record(base) && record(next)) {
    const changes: Record<string, Delta> = {};
    const removed = Object.keys(base).filter((key) => !Object.hasOwn(next, key));
    for (const key of Object.keys(next)) {
      const patch = Object.hasOwn(base, key)
        ? difference(base[key], next[key])
        : { kind: "replace" as const, value: next[key] };
      if (patch) put(changes, key, patch);
    }
    return removed.length || Object.keys(changes).length
      ? { kind: "object", changes, removed }
      : null;
  }
  return { kind: "replace", value: next };
}

function delta(base: WorkflowVersionConfig, next: WorkflowVersionConfig): Delta | null {
  let byBase = deltaCache.get(next);
  if (!byBase) {
    byBase = new WeakMap();
    deltaCache.set(next, byBase);
  }
  if (byBase.has(base)) return byBase.get(base)!;
  const patch = difference(base, next);
  byBase.set(base, patch);
  return patch;
}

/** The runtime keeps the existing version interface; persistence stores bounded delta chains. */
export function encodeWorkflowVersionHistory(history: WorkflowVersionHistory): unknown {
  if (!history || history.version !== 1 || !history.versions.length) throw invalid();
  const cached = encoded.get(history);
  if (cached) return cached;
  checkBudget(size(history));
  const contents: Content[] = [];
  const snapshots: WorkflowVersionConfig[] = [];
  const references = new Map<WorkflowVersionConfig, number>();
  const add = (config: WorkflowVersionConfig, archive = false): number => {
    if (!configuration(config) || (!archive && !record(config.models))) throw invalid();
    const known = references.get(config);
    if (known !== undefined) return known;
    const index = contents.length;
    const base = snapshots.at(-1);
    let content: Content = { kind: "full", value: config };
    if (base && index % CHECKPOINT_INTERVAL !== 0) {
      const patch = delta(base, config) ?? { kind: "object" as const, changes: {}, removed: [] };
      if (size(patch) < size(config)) content = { kind: "delta", base: index - 1, patch };
    }
    references.set(config, index);
    snapshots.push(config);
    contents.push(content);
    return index;
  };
  const result: StoredHistory = {
    ...Object.fromEntries(
      Object.entries(history).filter(
        ([key]) => !["version", "versions", "runtimeArchives", "contents"].includes(key),
      ),
    ),
    version: 2,
    currentVersionId: history.currentVersionId,
    versions: history.versions.map(({ config, ...metadata }) => ({
      ...metadata,
      content: add(config),
    })),
    preferredChildByVersion: history.preferredChildByVersion,
    ...(history.runtimeArchives
      ? { runtimeArchives: history.runtimeArchives.map((config) => add(config, true)) }
      : {}),
    contents,
  };
  encoded.set(history, result);
  return result;
}

function apply(base: unknown, patch: unknown, depth = 0): unknown {
  // The history backend replaces base64/b64_json fields wholesale, including delta entries.
  if (patch === "<内联图片数据已排除>") return patch;
  if (!record(patch) || depth > 256) throw invalid();
  if (patch["kind"] === "replace" && Object.hasOwn(patch, "value")) return patch["value"];
  if (
    patch["kind"] === "object" &&
    record(base) &&
    record(patch["changes"]) &&
    Array.isArray(patch["removed"])
  ) {
    const next = { ...base };
    for (const key of patch["removed"]) {
      // Credential fields may already have been removed by backend sanitization.
      if (typeof key !== "string") throw invalid();
      delete next[key];
    }
    for (const [key, change] of Object.entries(patch["changes"]))
      put(next, key, apply(Object.hasOwn(base, key) ? base[key] : undefined, change, depth + 1));
    return next;
  }
  if (
    patch["kind"] === "array" &&
    Array.isArray(base) &&
    Number.isSafeInteger(patch["length"]) &&
    (patch["length"] as number) >= 0 &&
    Array.isArray(patch["changes"])
  ) {
    const length = patch["length"] as number;
    // Appending must explicitly supply every new item: a tiny patch cannot allocate a huge sparse array.
    if (length - base.length > patch["changes"].length) throw invalid();
    const next = base.slice(0, length);
    const seen = new Set<number>();
    const changes: readonly unknown[] = patch["changes"];
    for (const change of changes) {
      if (!Array.isArray(change) || change.length !== 2) throw invalid();
      const pair: readonly unknown[] = change;
      const index = pair[0];
      const child = pair[1];
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= length ||
        seen.has(index)
      )
        throw invalid();
      seen.add(index);
      next[index] = apply(base[index], child, depth + 1);
    }
    for (let index = base.length; index < length; index += 1) if (!seen.has(index)) throw invalid();
    return next;
  }
  throw invalid();
}

function configuration(value: unknown): value is WorkflowVersionConfig {
  return (
    record(value) &&
    !Object.hasOwn(value, "versionHistory") &&
    typeof value["brief"] === "string" &&
    record(value["checkpoint"])
  );
}

export function decodeWorkflowVersionHistory(value: unknown): WorkflowVersionHistory {
  if (!record(value)) throw invalid();
  // V1 remains readable and is validated by the existing runtime version module.
  if (value["version"] === 1) return value as unknown as WorkflowVersionHistory;
  const cached = decoded.get(value);
  if (cached) return cached;
  if (
    value["version"] !== 2 ||
    !Array.isArray(value["contents"]) ||
    !Array.isArray(value["versions"]) ||
    !value["versions"].length ||
    typeof value["currentVersionId"] !== "string" ||
    !record(value["preferredChildByVersion"])
  )
    throw invalid();
  const contents: WorkflowVersionConfig[] = [];
  const depths: number[] = [];
  let materializedBytes = 0;
  for (const item of value["contents"]) {
    if (!record(item)) throw invalid();
    let config: unknown;
    let chainDepth = 0;
    if (item["kind"] === "full") config = item["value"];
    else if (
      item["kind"] === "delta" &&
      Number.isSafeInteger(item["base"]) &&
      (item["base"] as number) >= 0 &&
      (item["base"] as number) < contents.length
    ) {
      const base = item["base"] as number;
      chainDepth = depths[base]! + 1;
      if (chainDepth >= CHECKPOINT_INTERVAL) throw invalid();
      config = apply(contents[base], item["patch"]);
    } else throw invalid();
    if (!configuration(config)) throw invalid();
    materializedBytes += size(config);
    checkBudget(materializedBytes);
    depths.push(chainDepth);
    contents.push(config);
  }
  let expandedBytes = 0;
  const readContent = (index: unknown): WorkflowVersionConfig => {
    if (!Number.isSafeInteger(index) || (index as number) < 0 || !contents[index as number])
      throw invalid();
    const config = contents[index as number]!;
    expandedBytes += size(config);
    checkBudget(expandedBytes);
    return config;
  };
  const parents = new Map<string, string | null>();
  const versions = value["versions"].map((item: unknown) => {
    if (
      !record(item) ||
      typeof item["id"] !== "string" ||
      !item["id"] ||
      parents.has(item["id"]) ||
      typeof item["createdAt"] !== "number" ||
      !Number.isFinite(item["createdAt"]) ||
      typeof item["label"] !== "string" ||
      (item["parentId"] !== null &&
        (typeof item["parentId"] !== "string" || !parents.has(item["parentId"]))) ||
      (item["open"] !== undefined && typeof item["open"] !== "boolean") ||
      (item["updatedAt"] !== undefined &&
        (typeof item["updatedAt"] !== "number" || !Number.isFinite(item["updatedAt"])))
    )
      throw invalid();
    parents.set(item["id"], item["parentId"]);
    const { content, ...metadata } = item;
    const config = readContent(content);
    if (!record(config.models)) throw invalid();
    return { ...metadata, config };
  });
  if (!parents.has(value["currentVersionId"])) throw invalid();
  for (const [parent, child] of Object.entries(value["preferredChildByVersion"])) {
    if (typeof child !== "string" || !parents.has(parent) || parents.get(child) !== parent)
      throw invalid();
  }
  const archives = value["runtimeArchives"];
  if (archives !== undefined && !Array.isArray(archives)) throw invalid();
  const result = {
    ...Object.fromEntries(
      Object.entries(value).filter(
        ([key]) => !["version", "versions", "runtimeArchives", "contents"].includes(key),
      ),
    ),
    version: 1,
    currentVersionId: value["currentVersionId"],
    versions,
    preferredChildByVersion: value["preferredChildByVersion"],
    ...(Array.isArray(archives) ? { runtimeArchives: archives.map(readContent) } : {}),
  } as unknown as WorkflowVersionHistory;
  checkBudget(size(result));
  decoded.set(value, result);
  encoded.set(result, value as unknown as StoredHistory);
  return result;
}

function mapNode(value: unknown, encode: boolean): unknown {
  if (!record(value) || value["kind"] !== "knowledge_video_workflow" || !record(value["config"]))
    return value;
  const config = value["config"];
  const history = config["versionHistory"];
  if (history === undefined || (encode && record(history) && history["version"] === 2))
    return value;
  if (encode) checkBudget(size(value));
  const mapped = encode
    ? encodeWorkflowVersionHistory(history as WorkflowVersionHistory)
    : decodeWorkflowVersionHistory(history);
  if (mapped === history) return value;
  const next = { ...value, config: { ...config, versionHistory: mapped } };
  if (!encode) checkBudget(size(next));
  return next;
}

export const encodeWorkflowVersionNode = (value: unknown): unknown => mapNode(value, true);
export const decodeWorkflowVersionNode = (value: unknown): unknown => mapNode(value, false);

function mapDocument(value: unknown, encode: boolean): unknown {
  if (!record(value) || !Array.isArray(value["knowledgeVideoWorkflowNodes"])) return value;
  let changed = false;
  const nodes = value["knowledgeVideoWorkflowNodes"].map((node: unknown) => {
    const next = mapNode(node, encode);
    changed ||= node !== next;
    return next;
  });
  return changed ? { ...value, knowledgeVideoWorkflowNodes: nodes } : value;
}
export const encodeWorkflowVersionDocument = (value: unknown): unknown => mapDocument(value, true);
export const decodeWorkflowVersionDocument = (value: unknown): unknown => mapDocument(value, false);
