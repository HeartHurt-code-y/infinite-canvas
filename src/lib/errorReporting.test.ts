import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
const native = vi.hoisted(() => ({ fetch: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: native.fetch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import {
  clientReportSchema,
  errorDiagnostic,
  FeedbackReporter,
  FeedbackSendError,
  FEEDBACK_STORAGE_KEY,
  FEEDBACK_ENDPOINT,
  captureApplicationError,
  captureBackendEventFailure,
  getFeedbackReporter,
  installErrorReporting,
  scrubFeedbackText,
  feedbackOccurrence,
  type ClientReport,
} from "./errorReporting";
import { invokeDesktop } from "./ipc";
import {
  automaticDiagnosticCollection,
  type DiagnosticCollection,
  type PreparedDiagnostics,
} from "./diagnosticAttachments";

function harness() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const send = vi.fn((report: ClientReport) =>
    Promise.resolve({
      reportId: report.reportId,
      groupId: "a".repeat(64),
      received: true as const,
    }),
  );
  let now = Date.parse("2026-10-19T00:00:00.000Z");
  const options = {
    storage,
    send,
    now: () => now,
    prepareDiagnostics: (_occurrence: unknown, collection: DiagnosticCollection) =>
      Promise.resolve({
        reportId: crypto.randomUUID(),
        diagnostics: {
          schemaVersion: 1 as const,
          ...collection,
          tokenHash: "b".repeat(64),
          byteLength: 1000,
          sha256: "c".repeat(64),
        },
        preview: "test preview",
      }),
  };
  return {
    values,
    options,
    send,
    reporter: new FeedbackReporter(options),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const failure = {
  kind: "protocol",
  message: "sk-top-secret-value",
  details: {
    errorOrigin: "model",
    httpStatus: 502,
    requestId: "req-123",
    rawResponse: { prompt: "private user prompt", images: ["data:image/png;base64,SECRET"] },
  },
};

describe("anonymous error reporting", () => {
  it("keeps the original IPC task and request context when a common UI error action captures the same error again", () => {
    const error = new Error("correlated failure");
    captureApplicationError(error, "ipc", "start_generation", {
      args: { command: { canvasId: "canvas-original", userPrompt: "frozen prompt" } },
      taskId: "task-original",
    });
    captureApplicationError(error, "ui");
    expect(feedbackOccurrence(error)).toMatchObject({
      operation: "start_generation",
      taskId: "task-original",
      args: { command: { canvasId: "canvas-original", userPrompt: "frozen prompt" } },
    });
  });
  it("prepares all diagnostic categories by default without consent, persists no sensitive text, and preserves an explicit opt-out across restarts", async () => {
    const h = harness();
    const consent = automaticDiagnosticCollection(new Date().toISOString());
    const prepared: PreparedDiagnostics = {
      reportId: crypto.randomUUID(),
      diagnostics: {
        schemaVersion: 1,
        ...consent,
        tokenHash: "b".repeat(64),
        byteLength: 1000,
        sha256: "c".repeat(64),
      },
      preview: "private-test-prompt and complete-test-key",
    };
    const prepareDiagnostics = vi.fn<
      (occurrence: unknown, collection: DiagnosticCollection) => Promise<PreparedDiagnostics>
    >(() => Promise.resolve(prepared));
    const discardDiagnostics = vi.fn(() => Promise.resolve());
    const reporter = new FeedbackReporter({ ...h.options, prepareDiagnostics, discardDiagnostics });
    reporter.capture(failure, "ipc", "run_prompt_node", {
      error: failure,
      args: { command: { userPrompt: "private-test-prompt" } },
    });
    await vi.waitFor(() => expect(reporter.getSnapshot().preparing).toBe(0));
    expect(prepareDiagnostics).toHaveBeenCalledOnce();
    expect(prepareDiagnostics.mock.calls[0]?.[1]).toMatchObject({
      collectionPolicy: "automatic-complete-v1",
      categories: ["apiKeys", "prompts", "rawResponse", "canvas", "assets"],
    });
    expect(prepareDiagnostics.mock.calls[0]?.[1]).not.toHaveProperty("consentConfirmed");
    expect(reporter.isPending(prepared.reportId)).toBe(true);
    expect(h.values.get(FEEDBACK_STORAGE_KEY)).not.toMatch(
      /private-test-prompt|complete-test-key|consentConfirmed/,
    );
    const restarted = new FeedbackReporter({
      ...h.options,
      prepareDiagnostics,
      discardDiagnostics,
    });
    expect(restarted.getSnapshot().automaticEnabled).toBe(true);
    expect(restarted.isPending(prepared.reportId)).toBe(true);
    restarted.setAutomaticEnabled(false);
    expect(restarted.isPending(prepared.reportId)).toBe(false);
    expect(discardDiagnostics).toHaveBeenCalledWith(prepared.reportId);
    expect(new FeedbackReporter(h.options).getSnapshot().automaticEnabled).toBe(false);
  });
  it("disabling collection during preparation prevents upload, while a storage failure remains visible as missing diagnostics", async () => {
    const h = harness();
    const consent = automaticDiagnosticCollection(new Date().toISOString());
    let resolve!: (value: PreparedDiagnostics) => void;
    const prepareDiagnostics = vi.fn(
      () =>
        new Promise<PreparedDiagnostics>((done) => {
          resolve = done;
        }),
    );
    const discardDiagnostics = vi.fn(() => Promise.resolve());
    const reporter = new FeedbackReporter({ ...h.options, prepareDiagnostics, discardDiagnostics });
    reporter.capture(failure, "ipc", "start_generation");
    await vi.waitFor(() => expect(prepareDiagnostics).toHaveBeenCalledOnce());
    reporter.setAutomaticEnabled(false);
    const prepared: PreparedDiagnostics = {
      reportId: crypto.randomUUID(),
      diagnostics: {
        schemaVersion: 1,
        ...consent,
        tokenHash: "b".repeat(64),
        byteLength: 1000,
        sha256: "c".repeat(64),
      },
      preview: "sensitive",
    };
    resolve(prepared);
    await vi.waitFor(() => expect(discardDiagnostics).toHaveBeenCalledWith(prepared.reportId));
    expect(reporter.getSnapshot().pending).toBe(0);
    prepareDiagnostics.mockRejectedValueOnce(new Error("private-test-collection-error"));
    reporter.setAutomaticEnabled(true);
    reporter.capture(failure, "ipc", "run_prompt_node");
    await vi.waitFor(() => expect(reporter.getSnapshot().preparing).toBe(0));
    await reporter.flush();
    expect(h.send.mock.calls.at(-1)![0].diagnostic.diagnosticsUnavailable).toBe(true);
    expect(h.values.get(FEEDBACK_STORAGE_KEY)).not.toContain("private-test-collection-error");
  });
  it("captures production IPC failures, failed background events and unhandled exceptions using credential-free native HTTP", async () => {
    const h = harness();
    const target = Object.assign(new EventTarget(), {
      __TAURI_INTERNALS__: {},
      setInterval,
      clearInterval,
    });
    vi.stubGlobal("window", target);
    vi.stubGlobal("localStorage", h.options.storage);
    vi.stubEnv("PROD", true);
    native.fetch.mockImplementation((_url: string, init: { body: string }) => {
      const report = JSON.parse(init.body) as ClientReport;
      return Promise.resolve(
        new Response(
          JSON.stringify({ reportId: report.reportId, groupId: "a".repeat(64), received: true }),
        ),
      );
    });
    const stop = installErrorReporting();
    try {
      native.invoke.mockRejectedValueOnce(failure);
      await expect(
        invokeDesktop("submit_generation_task", v.unknown(), {
          apiKey: "never-send-key",
          prompt: "never-send-prompt",
        }),
      ).rejects.toEqual(failure);
      captureBackendEventFailure("generation:state-changed", { status: "failed", error: failure });
      captureBackendEventFailure("generation:state-changed", {
        status: "cancelled",
        error: failure,
      });
      target.dispatchEvent(
        Object.assign(new Event("error"), {
          error: new ReferenceError("never-send-runtime-message"),
        }),
      );
      await getFeedbackReporter().flush();
      expect(native.fetch).toHaveBeenCalledTimes(3);
      for (const [url, options] of native.fetch.mock.calls) {
        expect(url).toBe(FEEDBACK_ENDPOINT);
        expect(options).toMatchObject({
          credentials: "omit",
          maxRedirections: 0,
          redirect: "error",
          headers: { "Content-Type": "application/json" },
        });
        expect(JSON.stringify(options)).not.toMatch(/never-send|rawResponse|Authorization|Cookie/);
      }
    } finally {
      stop();
    }
    captureApplicationError(new Error("after cleanup"), "javascript");
    expect(getFeedbackReporter().getSnapshot().pending).toBe(0);
  });
  it("projects only approved metadata, never the error text, arguments or provider bodies", async () => {
    const h = harness();
    h.reporter.capture(failure, "ipc", "submit_generation_task");
    await h.reporter.flush();
    const report = h.send.mock.calls[0]![0];
    expect(v.safeParse(clientReportSchema, report).success).toBe(true);
    expect(report.diagnostic).toMatchObject({
      category: "model",
      operation: "submit_generation_task",
      httpStatus: 502,
      requestId: "req-123",
    });
    const serialized = JSON.stringify(report);
    for (const secret of ["sk-top-secret-value", "private user prompt", "base64", "images"])
      expect(serialized).not.toContain(secret);
    expect(h.reporter.getSnapshot().pending).toBe(0);
  });
  it("retains only file basenames and coordinates from a JavaScript stack", () => {
    const error = new TypeError("private prompt in message");
    error.stack =
      "TypeError: private prompt in message\n at secretUser (https://private.example/assets/index-abc.js:42:3)\n at helper (C:\\Users\\private\\src\\render.tsx:7:9)";
    expect(errorDiagnostic(error).frames).toEqual([
      { file: "index-abc.js", line: 42, column: 3 },
      { file: "render.tsx", line: 7, column: 9 },
    ]);
    expect(JSON.stringify(errorDiagnostic(error))).not.toMatch(/private|secretUser|https|Users/);
  });
  it("coalesces unsent errors and suppresses repeats after a successful send", async () => {
    const h = harness();
    for (let index = 0; index < 5; index++)
      h.reporter.capture(failure, "ipc", "submit_generation_task");
    await h.reporter.flush();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send.mock.calls[0]![0].occurrences).toBe(5);
    h.reporter.capture(
      { ...failure, details: { ...failure.details, requestId: "req-456" } },
      "ipc",
      "submit_generation_task",
    );
    await h.reporter.flush();
    expect(h.send).toHaveBeenCalledOnce();
    h.advance(10 * 60_000);
    h.reporter.capture(failure, "ipc", "submit_generation_task");
    await h.reporter.flush();
    expect(h.send).toHaveBeenCalledTimes(2);
  });
  it("reuses the exact report after a lost response and an application restart", async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new Error("connection closed after server persisted report"));
    h.reporter.capture(failure, "ipc", "submit_generation_task");
    await h.reporter.flush();
    const first = structuredClone(h.send.mock.calls[0]![0]);
    h.reporter.capture(failure, "ipc", "submit_generation_task");
    const restarted = new FeedbackReporter(h.options);
    h.advance(30_000);
    await restarted.flush();
    expect(h.send.mock.calls[1]![0]).toEqual(first);
    expect(restarted.getSnapshot().pending).toBe(0);
  });
  it("turning off automatic reports discards automatic pending records but retains manual feedback", async () => {
    const h = harness();
    h.send.mockRejectedValue(new Error("offline"));
    h.reporter.capture(failure, "ipc");
    const result = await h.reporter.submitManual(
      errorDiagnostic(null),
      "clicking save fails",
      "me@example.test",
    );
    h.reporter.setAutomaticEnabled(false);
    h.reporter.capture(new Error("new failure"), "javascript");
    expect(h.reporter.getSnapshot().pending).toBe(1);
    const restarted = new FeedbackReporter(h.options);
    expect(restarted.getSnapshot().automaticEnabled).toBe(false);
    expect(restarted.isPending(result.reportId)).toBe(true);
    expect(restarted.isDelivered(result.reportId)).toBe(false);
  });
  it("does not report ordinary input validation or treat an invalid receipt as delivery", async () => {
    const h = harness();
    h.reporter.capture({ kind: "validation", message: "missing prompt" }, "ui");
    expect(h.reporter.getSnapshot().pending).toBe(0);
    h.reporter.capture(
      { kind: "validation", message: "remote request failed", details: { httpStatus: 503 } },
      "ipc",
      "submit_generation_task",
    );
    expect(h.reporter.getSnapshot().pending).toBe(1);
    h.reporter.clearPending();
    h.send.mockResolvedValueOnce({
      reportId: crypto.randomUUID(),
      groupId: "a".repeat(64),
      received: true,
    });
    const result = await h.reporter.submitManual(errorDiagnostic(null), "", "");
    expect(result.sent).toBe(false);
    expect(h.reporter.getSnapshot().pending).toBe(1);
  });
  it("blocks permanent rejections without a reporting loop and permits explicit retry", async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new FeedbackSendError(400));
    const result = await h.reporter.submitManual(errorDiagnostic(null), "feedback", "");
    h.advance(3_600_000);
    await h.reporter.flush();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.reporter.getSnapshot().blocked).toBe(1);
    await h.reporter.retryPending();
    expect(h.reporter.isDelivered(result.reportId)).toBe(true);
  });
  it("survives unavailable storage and rejects tampered payloads on restoration", () => {
    const h = harness();
    h.reporter.capture(failure, "ipc");
    const saved = JSON.parse(h.values.get(FEEDBACK_STORAGE_KEY)!) as {
      queue: { report: Record<string, unknown> }[];
    };
    saved.queue[0]!.report["rawPayload"] = "secret";
    h.values.set(FEEDBACK_STORAGE_KEY, JSON.stringify(saved));
    expect(new FeedbackReporter(h.options).getSnapshot().pending).toBe(0);
    const broken = new FeedbackReporter({
      ...h.options,
      storage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("quota");
        },
      },
    });
    broken.capture(failure, "ipc");
    expect(broken.getSnapshot()).toMatchObject({ storageAvailable: false, pending: 1 });
  });
  it("keeps the offline queue bounded and removes expired reports on restart", () => {
    const h = harness();
    for (let index = 0; index < 80; index++)
      h.reporter.capture(failure, "ipc", `operation_${index}`);
    expect(h.reporter.getSnapshot().pending).toBe(50);
    h.advance(8 * 86_400_000);
    expect(new FeedbackReporter(h.options).getSnapshot().pending).toBe(0);
  });
  it("scrubs recognizable credentials and media from intentionally submitted feedback", () => {
    const text =
      'api_key="plain-key" Bearer abc123 sk-secret012345 https://example.test/file?token=secret data:image/png;base64,AAAA C:\\Users\\someone\\image.png';
    const scrubbed = scrubFeedbackText(text);
    for (const secret of ["plain-key", "abc123", "secret012345", "example.test", "AAAA", "someone"])
      expect(scrubbed).not.toContain(secret);
  });
});
