import { describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, options: RequestInit) => Promise<Response>>(),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: native.fetch }));
import {
  diagnosticJobStore,
  persistDiagnosticPayload,
  loadDiagnosticPayload,
  DIAGNOSTIC_CHUNK_BYTES,
  type DiagnosticPayload,
  automaticDiagnosticCollection,
  base64ToBytes,
} from "./diagnosticAttachments";
import {
  FeedbackReporter,
  sendFeedbackReport,
  errorDiagnostic,
  type ClientReport,
} from "./errorReporting";

function payload(padding = ""): DiagnosticPayload {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    collection: automaticDiagnosticCollection(new Date().toISOString()),
    apiKeys: [
      {
        providerConnectionId: "test-provider",
        credentialRef: "test-ref",
        key: "complete-opaque-test-credential",
      },
    ],
    prompts: "完整私人提示词",
    rawResponse: { response: "模型完整正文", padding },
    canvas: { nodes: [] },
    assets: [
      {
        name: "sample.bin",
        mimeType: "application/octet-stream",
        byteLength: 4,
        dataBase64: "AAECAw==",
      },
    ],
    unavailable: [],
  };
}
describe("encrypted local diagnostics and resumable native transport", () => {
  it("a fresh automatic reporter sends full diagnostic bytes without a consent dialog or manual submission", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.fetch.mockReset();
    const data = payload();
    let uploaded = "";
    let original: ClientReport | undefined;
    native.fetch.mockImplementation((url, options) => {
      if (url.endsWith("/api/client-reports")) {
        original = JSON.parse(options.body as string) as ClientReport;
        return Promise.resolve(
          Response.json({ received: true, reportId: original.reportId, groupId: "a".repeat(64) }),
        );
      }
      if (url.endsWith("/status"))
        return Promise.resolve(Response.json({ status: "uploading", receivedIndexes: [] }));
      if (url.endsWith("/complete"))
        return Promise.resolve(Response.json({ received: true, reportId: original!.reportId }));
      uploaded = (JSON.parse(options.body as string) as { data: string }).data;
      return Promise.resolve(Response.json({ received: true, index: 0 }));
    });
    const reporter = new FeedbackReporter({
      storage: null,
      send: sendFeedbackReport,
      prepareDiagnostics: (_occurrence, collection) =>
        persistDiagnosticPayload({ ...data, collection }),
    });
    expect(reporter.getSnapshot().automaticEnabled).toBe(true);
    reporter.capture(new Error("automatic raw failure"), "javascript");
    await reporter.flush();
    expect(original).toMatchObject({
      kind: "automatic",
      diagnostics: {
        collectionPolicy: "automatic-complete-v1",
        categories: ["apiKeys", "prompts", "rawResponse", "canvas", "assets"],
      },
    });
    expect(original!.diagnostics).not.toHaveProperty("consentConfirmed");
    const full = JSON.parse(new TextDecoder().decode(base64ToBytes(uploaded))) as DiagnosticPayload;
    expect(full.apiKeys).toEqual(data.apiKeys);
    expect(full.prompts).toEqual(data.prompts);
    expect(full.rawResponse).toEqual(data.rawResponse);
    expect(full.canvas).toEqual(data.canvas);
    expect(full.assets).toEqual(data.assets);
    expect(reporter.getSnapshot().pending).toBe(0);
    native.fetch.mockClear();
  });
  it("stores ciphertext and a nonextractable key in real IndexedDB, surviving another store read", async () => {
    const data = payload();
    const prepared = await persistDiagnosticPayload(data);
    try {
      const stored = (await diagnosticJobStore.get(prepared.reportId))!;
      expect(stored.key.extractable).toBe(false);
      expect(new TextDecoder().decode(stored.ciphertext)).not.toContain(data.apiKeys![0]!.key);
      expect(prepared.preview).not.toContain(data.apiKeys![0]!.key);
      expect(prepared.preview).not.toContain("AAECAw==");
      const loaded = await loadDiagnosticPayload(prepared.reportId);
      expect(JSON.parse(new TextDecoder().decode(loaded.bytes))).toEqual(data);
      expect(loaded.token).toMatch(/^[a-f0-9]{64}$/);
      await expect(crypto.subtle.exportKey("raw", stored.key)).rejects.toThrow();
    } finally {
      await diagnosticJobStore.delete(prepared.reportId);
    }
    await expect(loadDiagnosticPayload(prepared.reportId)).rejects.toThrow("已过期或被清除");
  });
  it("resumes from acknowledged chunks after an interrupted native upload and only confirms after complete", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const prepared = await persistDiagnosticPayload(payload("x".repeat(DIAGNOSTIC_CHUNK_BYTES)));
    const report: ClientReport = {
      schemaVersion: 1,
      reportId: prepared.reportId,
      installationId: crypto.randomUUID(),
      application: "infinite-canvas",
      appVersion: "0.2.7",
      platform: "windows",
      kind: "manual",
      source: "manual",
      fingerprint: "0123456789abcdef",
      occurredAt: new Date().toISOString(),
      occurrences: 1,
      diagnostic: errorDiagnostic(new Error("test")),
      description: "",
      contact: "",
      diagnostics: prepared.diagnostics,
    };
    const received = new Set<number>();
    let interrupted = false;
    native.fetch.mockImplementation((url: string, options: RequestInit) => {
      if (url.endsWith("/api/client-reports"))
        return Promise.resolve(
          Response.json({ received: true, reportId: report.reportId, groupId: "a".repeat(64) }),
        );
      if (url.endsWith("/status"))
        return Promise.resolve(
          Response.json({ receivedIndexes: [...received], status: "uploading" }),
        );
      if (url.endsWith("/complete"))
        return Promise.resolve(Response.json({ received: true, reportId: report.reportId }));
      const index = Number(url.split("/").at(-1));
      if (index === 1 && !interrupted) {
        interrupted = true;
        return Promise.reject(new Error("interrupted connection"));
      }
      expect(
        (JSON.parse(typeof options.body === "string" ? options.body : "{}") as { data?: unknown })
          .data,
      ).toBeTypeOf("string");
      received.add(index);
      return Promise.resolve(Response.json({ received: true, index }));
    });
    await expect(sendFeedbackReport(report)).rejects.toThrow("interrupted connection");
    expect(await diagnosticJobStore.get(report.reportId)).toBeDefined();
    expect(received).toEqual(new Set([0]));
    await expect(sendFeedbackReport(report)).resolves.toMatchObject({
      received: true,
      reportId: report.reportId,
    });
    expect(await diagnosticJobStore.get(report.reportId)).toBeUndefined();
    expect(
      native.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chunks/0")),
    ).toHaveLength(1);
    const bases = native.fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/client-reports"),
    );
    expect(bases[0]![1].body).toBe(bases[1]![1].body);
    for (const [url, options] of native.fetch.mock.calls) {
      expect(options.credentials).toBe("omit");
      expect(JSON.stringify(options.headers)).not.toContain("complete-opaque-test-credential");
      if (String(url).endsWith("/status"))
        expect(options.headers).not.toHaveProperty("Content-Type");
    }
    native.fetch.mockClear();
    await expect(sendFeedbackReport(report)).rejects.toThrow("已过期或被清除");
    expect(native.fetch).not.toHaveBeenCalled();
  });
});
