import * as v from "valibot";
import { version } from "../../package.json";
import {
  diagnosticGrantSchema,
  automaticDiagnosticCollection,
  diagnosticJobStore,
  DiagnosticAttachmentError,
  bytesToBase64,
  DIAGNOSTIC_CHUNK_BYTES,
  loadDiagnosticPayload,
  type DiagnosticCollection,
  type DiagnosticOccurrence,
  type PreparedDiagnostics,
} from "./diagnosticAttachments";

export const FEEDBACK_ENDPOINT = "https://fzy-ai.pages.dev/api/client-reports";
export const FEEDBACK_STORAGE_KEY = "infinite-canvas:feedback:v1";
export const FEEDBACK_OPEN_EVENT = "infinite-canvas:open-feedback";
const categories = [
  "validation",
  "network",
  "storage",
  "credential",
  "backend-contract",
  "runtime",
  "model",
  "unknown",
] as const;
const sources = [
  "ipc",
  "ui",
  "toast",
  "javascript",
  "unhandled_rejection",
  "react",
  "manual",
] as const;
const errorNames = [
  "Error",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "BackendContractError",
  "UnknownError",
] as const;
const uuidSchema = v.pipe(v.string(), v.uuid());
const frameSchema = v.strictObject({
  file: v.pipe(v.string(), v.maxLength(100), v.regex(/^[a-z0-9_.-]+\.(?:js|mjs|ts|tsx|rs)$/i)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000_000)),
  column: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000_000)),
});
export const diagnosticSchema = v.strictObject({
  category: v.picklist(categories),
  operation: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_:-]{0,79}$/)),
  errorName: v.picklist(errorNames),
  httpStatus: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))),
  requestId: v.nullable(v.pipe(v.string(), v.regex(/^(?:[0-9a-f-]{36}|req-[a-z0-9]{1,24})$/i))),
  frames: v.pipe(v.array(frameSchema), v.maxLength(8)),
  backendKind: v.optional(
    v.picklist([
      "validation",
      "database",
      "credential",
      "transport",
      "io",
      "json",
      "url",
      "desktop",
      "protocol",
      "not_found",
      "conflict",
      "backend-contract",
    ]),
  ),
  osError: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(-2_147_483_648), v.maxValue(2_147_483_647)),
  ),
  isTimeout: v.optional(v.boolean()),
  isConnect: v.optional(v.boolean()),
  diagnosticsUnavailable: v.optional(v.literal(true)),
  diagnosticsIncomplete: v.optional(v.literal(true)),
});
export const clientReportSchema = v.strictObject({
  schemaVersion: v.literal(1),
  reportId: uuidSchema,
  installationId: uuidSchema,
  application: v.literal("infinite-canvas"),
  appVersion: v.pipe(v.string(), v.maxLength(40), v.regex(/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i)),
  platform: v.picklist(["windows", "macos", "linux", "browser", "unknown"]),
  kind: v.picklist(["automatic", "manual"]),
  source: v.picklist(sources),
  fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{16}$/)),
  occurredAt: v.pipe(v.string(), v.isoTimestamp()),
  occurrences: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  diagnostic: diagnosticSchema,
  description: v.pipe(v.string(), v.maxLength(2000)),
  contact: v.pipe(v.string(), v.maxLength(160)),
  diagnostics: v.optional(diagnosticGrantSchema),
});
export type ClientDiagnostic = v.InferOutput<typeof diagnosticSchema>;
export type ClientReport = v.InferOutput<typeof clientReportSchema>;
export type ReportSource = (typeof sources)[number];
type StorageLike = Pick<Storage, "getItem" | "setItem">;
type QueueEntry = {
  report: ClientReport;
  attempts: number;
  nextAt: number;
  blocked: boolean;
  preparing?: boolean;
};
export interface FeedbackSnapshot {
  readonly automaticEnabled: boolean;
  readonly pending: number;
  readonly blocked: number;
  readonly sending: boolean;
  readonly storageAvailable: boolean;
  readonly preparing: number;
  readonly collectionError: unknown;
}
export interface FeedbackReceipt {
  reportId: string;
  groupId: string;
  received: true;
}
export class FeedbackSendError extends Error {
  constructor(readonly status: number) {
    super(
      status === 429
        ? "反馈发送较多，已保留，请稍后重试。"
        : "反馈暂未送达，已保留在此设备，请稍后重试。",
    );
    this.name = "FeedbackSendError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.length < 100_000) {
    try {
      const text = value.startsWith("workflow-error:v1:")
        ? value.slice("workflow-error:v1:".length)
        : value;
      return record(JSON.parse(text));
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Strict metadata projection. Never serialize error messages, arguments or raw provider responses. */
export function errorDiagnostic(error: unknown, operation = "application"): ClientDiagnostic {
  const value = record(error);
  const raw =
    value["origin"] === "model" || value["origin"] === "workflow" ? record(value["raw"]) : {};
  const details = record(value["details"] ?? raw["details"]);
  const kind = value["kind"];
  let category: ClientDiagnostic["category"] = "unknown";
  if (kind === "validation") category = "validation";
  else if (kind === "database" || kind === "io") category = "storage";
  else if (kind === "transport") category = "network";
  else if (kind === "credential") category = "credential";
  else if (kind === "backend-contract") category = "backend-contract";
  else if (error instanceof Error) category = "runtime";
  if (details["errorOrigin"] === "model" || value["origin"] === "model") category = "model";
  const status = details["httpStatus"] ?? details["status"];
  const requestId = details["requestId"];
  const name = error instanceof Error ? error.name : value["name"];
  const frames: ClientDiagnostic["frames"] = [];
  if (error instanceof Error && typeof error.stack === "string") {
    for (const line of error.stack.split("\n").slice(1, 30)) {
      // File basename and coordinates only: discard function names, absolute paths and URLs.
      const match = line.match(/(?:[\\/])([a-z0-9_.-]+\.(?:js|mjs|ts|tsx|rs)):(\d+):(\d+)\)?\s*$/i);
      if (match) {
        const frame = v.safeParse(frameSchema, {
          file: match[1],
          line: Number(match[2]),
          column: Number(match[3]),
        });
        if (frame.success) frames.push(frame.output);
      }
      if (frames.length === 8) break;
    }
  }
  return {
    category,
    operation: /^[a-z][a-z0-9_:-]{0,79}$/.test(operation) ? operation : "application",
    errorName: errorNames.includes(name as ClientDiagnostic["errorName"])
      ? (name as ClientDiagnostic["errorName"])
      : "UnknownError",
    httpStatus:
      typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    requestId:
      typeof requestId === "string" && /^(?:[0-9a-f-]{36}|req-[a-z0-9]{1,24})$/i.test(requestId)
        ? requestId
        : null,
    frames,
    ...([
      "validation",
      "database",
      "credential",
      "transport",
      "io",
      "json",
      "url",
      "desktop",
      "protocol",
      "not_found",
      "conflict",
      "backend-contract",
    ].includes(String(kind))
      ? { backendKind: kind as NonNullable<ClientDiagnostic["backendKind"]> }
      : {}),
    ...(typeof details["osError"] === "number" &&
    Number.isInteger(details["osError"]) &&
    Math.abs(details["osError"]) <= 2_147_483_647
      ? { osError: details["osError"] }
      : {}),
    ...(typeof details["isTimeout"] === "boolean" ? { isTimeout: details["isTimeout"] } : {}),
    ...(typeof details["isConnect"] === "boolean" ? { isConnect: details["isConnect"] } : {}),
  };
}

function fingerprint(text: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    left = Math.imul(left ^ text.charCodeAt(index), 0x01000193);
    right = Math.imul(right ^ text.charCodeAt(index), 0x85ebca6b);
  }
  return (left >>> 0).toString(16).padStart(8, "0") + (right >>> 0).toString(16).padStart(8, "0");
}

export function scrubFeedbackText(text: string): string {
  return text
    .replace(/data:[^\s,]+;base64,[a-z0-9+/=]+/gi, "[素材已移除]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, "[凭据已移除]")
    .replace(/\b(?:sk|rk|pk)[-_][a-z0-9_-]{8,}/gi, "[密钥已移除]")
    .replace(
      /((?:api[_ -]?key|authorization|cookie|password|secret|access[_ -]?token)\s*["']?\s*[:=]\s*["']?)[^\s,;}"']+/gi,
      "$1[凭据已移除]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, "[链接已移除]")
    .replace(/(?:[a-z]:\\|\\\\)[^\r\n"<>]+/gi, "[本机路径已移除]");
}

function platform(): ClientReport["platform"] {
  if (typeof navigator === "undefined") return "unknown";
  const agent = navigator.userAgent;
  return /Windows/i.test(agent)
    ? "windows"
    : /Mac/i.test(agent)
      ? "macos"
      : /Linux/i.test(agent)
        ? "linux"
        : "browser";
}

export class FeedbackReporter {
  private queue: QueueEntry[] = [];
  private recent = new Map<string, number>();
  private automaticEnabled = true;
  private preparationEpoch = 0;
  private preparing = 0;
  private collectionError: unknown = null;
  private preparationTail: Promise<void> = Promise.resolve();
  private pendingPreparations = new Set<Promise<void>>();
  private installationId: string;
  private listeners = new Set<() => void>();
  private delivered = new Set<string>();
  private deliveryErrors = new Map<string, unknown>();
  private running: Promise<void> | null = null;
  private storageAvailable = true;
  private snapshot!: FeedbackSnapshot;
  private readonly now: () => number;
  private readonly uuid: () => string;
  constructor(
    private readonly options: {
      storage: StorageLike | null;
      send: (report: ClientReport) => Promise<FeedbackReceipt>;
      now?: () => number;
      uuid?: () => string;
      prepareDiagnostics?: (
        occurrence: DiagnosticOccurrence,
        collection: DiagnosticCollection,
      ) => Promise<PreparedDiagnostics>;
      discardDiagnostics?: (reportId: string) => Promise<void>;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.installationId = this.uuid();
    this.restore();
    this.publish();
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snapshot;
  private restore() {
    try {
      if (!this.options.storage) {
        this.storageAvailable = false;
        return;
      }
      const saved = record(
        JSON.parse(this.options.storage.getItem(FEEDBACK_STORAGE_KEY) ?? "null"),
      );
      if (saved["schemaVersion"] !== 1) return;
      const id = v.safeParse(uuidSchema, saved["installationId"]);
      if (id.success) this.installationId = id.output;
      if (typeof saved["automaticEnabled"] === "boolean")
        this.automaticEnabled = saved["automaticEnabled"];
      if (Array.isArray(saved["queue"])) {
        for (const entry of saved["queue"].slice(0, 50)) {
          const row = record(entry);
          const parsed = v.safeParse(clientReportSchema, row["report"]);
          if (!parsed.success || parsed.output.installationId !== this.installationId) continue;
          if (this.now() - Date.parse(parsed.output.occurredAt) > 7 * 86_400_000) continue;
          if (
            parsed.output.kind === "automatic" &&
            (!this.automaticEnabled || parsed.output.description || parsed.output.contact)
          )
            continue;
          this.queue.push({
            report:
              row["preparing"] === true
                ? {
                    ...parsed.output,
                    diagnostic: { ...parsed.output.diagnostic, diagnosticsUnavailable: true },
                  }
                : parsed.output,
            attempts: Math.max(0, Math.min(100, Number(row["attempts"]) || 0)),
            nextAt: Number(row["nextAt"]) || 0,
            blocked: row["blocked"] === true,
          });
        }
      }
    } catch {
      this.storageAvailable = false;
    }
  }
  private publish() {
    try {
      if (this.options.storage) {
        this.options.storage.setItem(
          FEEDBACK_STORAGE_KEY,
          JSON.stringify({
            schemaVersion: 1,
            installationId: this.installationId,
            automaticEnabled: this.automaticEnabled,
            automaticCollectionPolicy: "automatic-complete-v1",
            queue: this.queue,
          }),
        );
        this.storageAvailable = true;
      }
    } catch {
      this.storageAvailable = false;
    }
    this.snapshot = {
      automaticEnabled: this.automaticEnabled,
      pending: this.queue.length,
      blocked: this.queue.filter((entry) => entry.blocked).length,
      sending: this.running !== null,
      storageAvailable: this.storageAvailable,
      preparing: this.preparing,
      collectionError: this.collectionError,
    };
    for (const listener of this.listeners) listener();
  }
  setAutomaticEnabled(enabled: boolean) {
    this.automaticEnabled = enabled;
    if (!enabled) {
      this.preparationEpoch++;
      this.recent.clear();
      this.collectionError = null;
      for (const entry of this.queue)
        if (entry.report.kind === "automatic" && entry.report.diagnostics)
          this.discardDiagnostics(entry.report.reportId);
      this.queue = this.queue.filter((entry) => entry.report.kind !== "automatic");
    }
    this.publish();
  }
  discardDiagnostics(reportId: string) {
    diagnosticTransfers.get(reportId)?.abort();
    void (this.options.discardDiagnostics ?? ((id) => diagnosticJobStore.delete(id)))(
      reportId,
    ).catch(() => undefined);
  }
  async prepareDiagnostics(
    occurrence: DiagnosticOccurrence,
    consent: DiagnosticCollection,
  ): Promise<PreparedDiagnostics> {
    this.preparing++;
    this.publish();
    const epoch = this.preparationEpoch;
    const prepare = this.preparationTail.then(async () => {
      if (epoch !== this.preparationEpoch) throw new Error("完整诊断收集已取消，请重新准备。");
      if (this.options.prepareDiagnostics)
        return this.options.prepareDiagnostics(occurrence, consent);
      return (await import("./collectFeedbackDiagnostics")).prepareFeedbackDiagnostics(
        occurrence,
        consent,
      );
    });
    this.preparationTail = prepare.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await prepare;
    } finally {
      this.preparing--;
      this.publish();
    }
  }
  clearPending() {
    this.preparationEpoch++;
    for (const entry of this.queue)
      if (entry.report.diagnostics) this.discardDiagnostics(entry.report.reportId);
    this.queue = [];
    this.deliveryErrors.clear();
    this.publish();
  }
  isPending(reportId: string) {
    return this.queue.some((entry) => entry.report.reportId === reportId);
  }
  isBlocked(reportId: string) {
    return this.queue.some((entry) => entry.report.reportId === reportId && entry.blocked);
  }
  isDelivered(reportId: string) {
    return this.delivered.has(reportId);
  }
  deliveryError(reportId: string): unknown {
    return this.deliveryErrors.get(reportId) ?? new Error("反馈暂未送达，已保留待发送记录。");
  }
  private makeReport(
    kind: ClientReport["kind"],
    source: ReportSource,
    diagnostic: ClientDiagnostic,
    description = "",
    contact = "",
  ): ClientReport {
    const report: ClientReport = {
      schemaVersion: 1,
      reportId: this.uuid(),
      installationId: this.installationId,
      application: "infinite-canvas",
      appVersion: version,
      platform: platform(),
      kind,
      source,
      fingerprint: fingerprint(JSON.stringify({ ...diagnostic, requestId: null })),
      occurredAt: new Date(this.now()).toISOString(),
      occurrences: 1,
      diagnostic,
      description: scrubFeedbackText(description).slice(0, 2000),
      contact: scrubFeedbackText(contact).slice(0, 160),
    };
    return v.parse(clientReportSchema, report);
  }
  capture(
    error: unknown,
    source: ReportSource,
    operation?: string,
    occurrence?: DiagnosticOccurrence,
  ) {
    if (!this.automaticEnabled) return;
    const diagnostic = errorDiagnostic(error, operation);
    if (
      diagnostic.category === "validation" &&
      diagnostic.httpStatus === null &&
      !diagnostic.isTimeout &&
      !diagnostic.isConnect
    )
      return; // Ordinary missing inputs are not software incidents; remote failures still matter.
    const report = this.makeReport("automatic", source, diagnostic);
    const queued = this.queue.find(
      (entry) =>
        entry.report.fingerprint === report.fingerprint &&
        entry.report.kind === "automatic" &&
        entry.attempts === 0,
    );
    if (queued) {
      queued.report = {
        ...queued.report,
        occurrences: Math.min(100, queued.report.occurrences + 1),
      };
      this.publish();
      return;
    }
    if (this.now() - (this.recent.get(report.fingerprint) ?? -Infinity) < 10 * 60_000) return;
    this.recent.set(report.fingerprint, this.now());
    if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value!);
    if (this.queue.length >= 50) return;
    const entry: QueueEntry = { report, attempts: 0, nextAt: 0, blocked: false, preparing: true };
    this.queue.push(entry);
    this.publish();
    const epoch = this.preparationEpoch;
    const preparation = this.prepareDiagnostics(
      occurrence ?? { error, ...(operation ? { operation } : {}) },
      automaticDiagnosticCollection(report.occurredAt),
    ).then(
      (prepared) => {
        if (
          epoch !== this.preparationEpoch ||
          !this.automaticEnabled ||
          !this.queue.includes(entry)
        ) {
          this.discardDiagnostics(prepared.reportId);
          return;
        }
        entry.report = {
          ...entry.report,
          reportId: prepared.reportId,
          diagnostics: prepared.diagnostics,
          diagnostic: {
            ...entry.report.diagnostic,
            ...(prepared.unavailable?.length ? { diagnosticsIncomplete: true as const } : {}),
          },
        };
        entry.preparing = false;
        this.publish();
      },
      (error: unknown) => {
        if (
          epoch !== this.preparationEpoch ||
          !this.automaticEnabled ||
          !this.queue.includes(entry)
        )
          return;
        this.collectionError = error;
        entry.report = {
          ...entry.report,
          diagnostic: { ...entry.report.diagnostic, diagnosticsUnavailable: true },
        };
        entry.preparing = false;
        this.publish();
      },
    );
    this.pendingPreparations.add(preparation);
    void preparation.then(
      () => this.pendingPreparations.delete(preparation),
      () => this.pendingPreparations.delete(preparation),
    );
  }
  async submitManual(
    diagnostic: ClientDiagnostic,
    description: string,
    contact: string,
    prepared?: PreparedDiagnostics,
    onQueued?: (receipt: { reportId: string; sent: boolean }) => void,
  ) {
    if (this.queue.length >= 50)
      throw new Error("待发送反馈已满。请先重试发送或清除待发送记录，再提交。 ");
    const basic = this.makeReport("manual", "manual", diagnostic, description, contact);
    const report = prepared
      ? v.parse(clientReportSchema, {
          ...basic,
          reportId: prepared.reportId,
          diagnostics: prepared.diagnostics,
          diagnostic: {
            ...basic.diagnostic,
            ...(prepared.unavailable?.length ? { diagnosticsIncomplete: true } : {}),
          },
        })
      : basic;
    this.queue.unshift({ report, attempts: 0, nextAt: 0, blocked: false });
    this.publish();
    onQueued?.({ reportId: report.reportId, sent: false });
    await this.flush();
    return { reportId: report.reportId, sent: this.isDelivered(report.reportId) };
  }
  async retryPending() {
    for (const entry of this.queue) {
      entry.nextAt = 0;
      entry.blocked = false;
    }
    await this.flush();
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
      this.publish();
    });
    this.publish();
    return this.running;
  }
  private async drain() {
    while (this.pendingPreparations.size) await Promise.allSettled([...this.pendingPreparations]);
    for (let sent = 0; sent < 50; sent++) {
      const entry = this.queue.find((item) => !item.blocked && item.nextAt <= this.now());
      if (!entry) break;
      if (this.now() - Date.parse(entry.report.occurredAt) > 7 * 86_400_000) {
        if (entry.report.diagnostics) this.discardDiagnostics(entry.report.reportId);
        this.queue = this.queue.filter((item) => item !== entry);
        continue;
      }
      entry.attempts++; // Once dispatched, freeze the payload for idempotent retries.
      this.publish();
      try {
        const receipt = await this.options.send(entry.report);
        if (
          receipt.reportId !== entry.report.reportId ||
          receipt.received !== true ||
          !/^[a-f0-9]{64}$/.test(receipt.groupId)
        )
          throw new Error("invalid receipt");
        this.queue = this.queue.filter((item) => item !== entry);
        if (entry.report.kind === "manual") this.delivered.add(entry.report.reportId);
        this.deliveryErrors.delete(entry.report.reportId);
        if (this.delivered.size > 100) this.delivered.delete(this.delivered.values().next().value!);
      } catch (error) {
        if (this.queue.includes(entry)) this.deliveryErrors.set(entry.report.reportId, error);
        entry.nextAt =
          this.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(entry.attempts - 1, 6));
        entry.blocked =
          (error instanceof FeedbackSendError || error instanceof DiagnosticAttachmentError) &&
          error.status >= 400 &&
          error.status < 500 &&
          ![404, 408, 429].includes(error.status);
        // Never report feedback transport errors back into the collector.
        break;
      }
      this.publish();
    }
  }
}

const diagnosticTransfers = new Map<string, AbortController>();
async function nativeFeedbackRequest(
  url: string,
  method: "POST" | "PUT",
  body?: string,
  token?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
    throw new Error("请在桌面软件中发送反馈。");
  const { fetch } = await import("@tauri-apps/plugin-http");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body }),
      credentials: "omit",
      redirect: "error",
      maxRedirections: 0,
      connectTimeout: 10_000,
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new FeedbackSendError(response.status);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function sendFeedbackReport(report: ClientReport): Promise<FeedbackReceipt> {
  const safeReport = v.parse(clientReportSchema, report);
  const controller = new AbortController();
  if (safeReport.diagnostics) diagnosticTransfers.set(safeReport.reportId, controller);
  try {
    const attachment = safeReport.diagnostics
      ? await loadDiagnosticPayload(safeReport.reportId)
      : null;
    if (
      attachment &&
      Object.entries(attachment.diagnostics).some(
        ([key, value]) =>
          JSON.stringify(value) !==
          JSON.stringify(safeReport.diagnostics?.[key as keyof typeof attachment.diagnostics]),
      )
    )
      throw new DiagnosticAttachmentError("本次反馈与暂存的诊断资料不一致，请重新准备。");
    const receipt = (await nativeFeedbackRequest(
      FEEDBACK_ENDPOINT,
      "POST",
      JSON.stringify(safeReport),
      undefined,
      controller.signal,
    )) as FeedbackReceipt;
    if (
      receipt.reportId !== safeReport.reportId ||
      receipt.received !== true ||
      !/^[a-f0-9]{64}$/.test(receipt.groupId)
    )
      throw new Error("反馈回执校验失败，报告已保留等待重试。");
    if (attachment) {
      const base = `${FEEDBACK_ENDPOINT}/${safeReport.reportId}/diagnostics`;
      const status = v.parse(
        v.object({
          receivedIndexes: v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255))),
          status: v.picklist(["uploading", "complete"]),
        }),
        await nativeFeedbackRequest(
          `${base}/status`,
          "POST",
          undefined,
          attachment.token,
          controller.signal,
        ),
      );
      const received = new Set(status.receivedIndexes);
      if (status.status !== "complete")
        for (
          let index = 0;
          index < Math.ceil(attachment.bytes.length / DIAGNOSTIC_CHUNK_BYTES);
          index++
        ) {
          if (received.has(index)) continue;
          const data = bytesToBase64(
            attachment.bytes.subarray(
              index * DIAGNOSTIC_CHUNK_BYTES,
              (index + 1) * DIAGNOSTIC_CHUNK_BYTES,
            ),
          );
          const result = v.parse(
            v.object({ received: v.literal(true), index: v.number() }),
            await nativeFeedbackRequest(
              `${base}/chunks/${index}`,
              "PUT",
              JSON.stringify({ data }),
              attachment.token,
              controller.signal,
            ),
          );
          if (result.index !== index) throw new Error("诊断分片回执不一致，请稍后重试。");
        }
      const completed = v.parse(
        v.object({ received: v.literal(true), reportId: v.string() }),
        await nativeFeedbackRequest(
          `${base}/complete`,
          "POST",
          undefined,
          attachment.token,
          controller.signal,
        ),
      );
      if (completed.reportId !== safeReport.reportId)
        throw new Error("完整诊断回执不一致，请稍后重试。");
      await diagnosticJobStore.delete(safeReport.reportId).catch(() => undefined);
    }
    return receipt;
  } finally {
    diagnosticTransfers.delete(safeReport.reportId);
  }
}

let sharedReporter: FeedbackReporter | null = null;
let activeReporter: FeedbackReporter | null = null;
export function getFeedbackReporter(): FeedbackReporter {
  if (!sharedReporter) {
    let storage: StorageLike | null = null;
    try {
      storage = typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      /* in-memory fallback */
    }
    sharedReporter = new FeedbackReporter({ storage, send: sendFeedbackReport });
  }
  return sharedReporter;
}
export function captureApplicationError(
  error: unknown,
  source: ReportSource,
  operation?: string,
  context?: {
    readonly args?: Record<string, unknown> | undefined;
    readonly taskId?: string | undefined;
    readonly canvasId?: string | undefined;
  },
): void {
  try {
    const previous =
      typeof error === "object" && error !== null
        ? diagnosticOccurrences.get(error)
        : recentOccurrences.get(fingerprint(typeof error === "string" ? error : String(error)));
    const occurrence: DiagnosticOccurrence = {
      ...previous,
      error,
      ...(operation ? { operation } : {}),
      ...(context?.taskId ? { taskId: context.taskId } : {}),
      ...(context?.canvasId ? { canvasId: context.canvasId } : {}),
      ...(context?.args ? { args: freezeDiagnosticArgs(operation, context.args) } : {}),
    };
    if (typeof error === "object" && error !== null) diagnosticOccurrences.set(error, occurrence);
    else {
      const key = fingerprint(typeof error === "string" ? error : String(error));
      recentOccurrences.set(key, occurrence);
      if (recentOccurrences.size > 20)
        recentOccurrences.delete(recentOccurrences.keys().next().value!);
    }
    activeReporter?.capture(error, source, operation ?? occurrence.operation, occurrence);
  } catch {
    /* Reporting must never affect creative work. */
  }
}
const diagnosticOccurrences = new WeakMap<object, DiagnosticOccurrence>();
const recentOccurrences = new Map<string, DiagnosticOccurrence>();
function freezeDiagnosticArgs(
  operation: string | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const selected = ["start_generation", "run_prompt_node"].includes(operation ?? "")
    ? args
    : {
        taskId: args["taskId"],
        canvasId: args["canvasId"],
        providerConnectionId: args["providerConnectionId"],
      };
  return JSON.parse(JSON.stringify(selected)) as Record<string, unknown>;
}
export function feedbackOccurrence(error: unknown): DiagnosticOccurrence {
  return (
    (typeof error === "object" && error !== null
      ? diagnosticOccurrences.get(error)
      : recentOccurrences.get(fingerprint(typeof error === "string" ? error : String(error)))) ?? {
      error,
    }
  );
}

export function captureBackendEventFailure(eventName: string, payload: unknown): void {
  const value = record(payload);
  const operation = `event:${eventName.replaceAll("-", "_")}`;
  if (["failed", "error"].includes(String(value["status"])) && value["error"] != null)
    captureApplicationError(
      value["error"],
      "ipc",
      operation,
      typeof value["taskId"] === "string" ? { taskId: value["taskId"] } : undefined,
    );
  if (eventName === "generation:retry-exhausted")
    captureApplicationError(
      value["reason"],
      "ipc",
      operation,
      typeof value["taskId"] === "string" ? { taskId: value["taskId"] } : undefined,
    );
}
export function openFeedback(diagnostic?: ClientDiagnostic, occurrence?: DiagnosticOccurrence) {
  window.dispatchEvent(
    new CustomEvent(FEEDBACK_OPEN_EVENT, { detail: { diagnostic, occurrence } }),
  );
}
export function installErrorReporting(): () => void {
  if (!import.meta.env.PROD || !("__TAURI_INTERNALS__" in window)) return () => undefined;
  const reporter = getFeedbackReporter();
  activeReporter = reporter;
  const onError = (event: ErrorEvent) =>
    captureApplicationError(event.error ?? event.message, "javascript");
  const onRejection = (event: PromiseRejectionEvent) =>
    captureApplicationError(event.reason, "unhandled_rejection");
  const flush = () => {
    void reporter.flush();
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("online", flush);
  const timer = window.setInterval(flush, 30_000);
  flush();
  return () => {
    activeReporter = null;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("online", flush);
    window.clearInterval(timer);
  };
}
