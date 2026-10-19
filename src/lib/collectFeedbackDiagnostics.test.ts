import { describe, expect, it, vi } from "vitest";
import {
  collectDiagnosticPayload,
  diagnosticContent,
  type DiagnosticCollectionServices,
} from "./collectFeedbackDiagnostics";
import { automaticDiagnosticCollection, type DiagnosticConsent } from "./diagnosticAttachments";

const consent: DiagnosticConsent = {
  consentedAt: "2026-10-19T00:00:00.000Z",
  consentConfirmed: true,
  categories: ["apiKeys", "prompts", "rawResponse", "canvas", "assets"],
};
function harness() {
  const canvas = {
    promptContents: { n: "画布提示词" },
    nodes: [{ providerId: "other-current-provider" }],
    assetNodes: [{ source: "local", assetId: "asset-1", kind: "image", name: "sample.png" }],
    media: { kind: "local_file", path: "C:\\test\\sample.bin" },
  };
  const task = {
    summary: { canvasId: "original-canvas" },
    resolvedRequest: { provider: { credentialReference: "original-ref" } },
    logicalRequest: { promptSegments: [{ text: "任务冻结提示词" }] },
    calls: [
      {
        request: { prompt: "do not duplicate request" },
        rawResponse: '{"full":"完整原始响应"}',
        responseHeaders: { Authorization: "opaque-selected-key" },
      },
    ],
    results: [],
  };
  const services: DiagnosticCollectionServices = {
    task: vi.fn(() => Promise.resolve(task)),
    canvas: vi.fn(() => canvas),
    credentials: vi.fn(() =>
      Promise.resolve([
        {
          providerConnectionId: "original",
          credentialRef: "original-ref",
          key: "opaque-selected-key",
        },
      ]),
    ),
    readFile: vi.fn(() => Promise.resolve(new Uint8Array([0, 1, 2, 3]))),
    localAsset: vi.fn(() => Promise.resolve("data:image/png;base64,AAECAw==")),
  };
  return { services, task, canvas };
}
describe("full diagnostic collection follows the original task and explicit choices", () => {
  it("collects all five sections with complete selected keys, frozen prompts, original responses and actual material bytes", async () => {
    const h = harness();
    const result = await collectDiagnosticPayload(
      { error: new Error("provider failed"), taskId: "original-task" },
      consent,
      h.services,
    );
    expect(h.services.canvas).toHaveBeenCalledWith("original-canvas");
    expect(h.services.credentials).toHaveBeenCalledWith(
      h.task.logicalRequest,
      h.task.resolvedRequest,
      h.canvas,
    );
    expect(result.apiKeys![0]!.key).toBe("opaque-selected-key");
    expect(JSON.stringify(result.prompts)).toContain("任务冻结提示词");
    expect(JSON.stringify(result.rawResponse)).toContain("完整原始响应");
    expect(JSON.stringify(result.rawResponse)).not.toContain("opaque-selected-key");
    expect(JSON.stringify(result.rawResponse)).not.toContain("do not duplicate request");
    expect(result.assets).toContainEqual({
      name: "sample.bin",
      mimeType: "application/octet-stream",
      byteLength: 4,
      dataBase64: "AAECAw==",
    });
    expect(result.assets).toContainEqual({
      name: "sample.png",
      mimeType: "image/png",
      byteLength: 4,
      dataBase64: "AAECAw==",
    });
    expect(result.canvas).toEqual(h.canvas);
  });
  it("does not export unselected key, prompt, response or embedded material sections", async () => {
    const h = harness();
    Object.assign(h.canvas, {
      rawResponse: "private response",
      embedded: "data:image/png;base64,AAECAw==",
      api_key: "opaque-selected-key",
    });
    const result = await collectDiagnosticPayload(
      { error: null },
      { ...consent, categories: ["canvas"] },
      h.services,
    );
    expect(result).not.toHaveProperty("apiKeys");
    expect(result).not.toHaveProperty("prompts");
    expect(result).not.toHaveProperty("rawResponse");
    expect(result).not.toHaveProperty("assets");
    expect(JSON.stringify(result)).not.toMatch(
      /画布提示词|private response|data:image|AAECAw|opaque-selected-key/,
    );
    expect(h.services.readFile).not.toHaveBeenCalled();
    expect(h.services.localAsset).not.toHaveBeenCalled();
  });
  it("a missing historical task never falls back to an unrelated active canvas or current credentials", async () => {
    const h = harness();
    h.services.task = vi.fn(() => Promise.reject(new Error("missing")));
    const result = await collectDiagnosticPayload(
      { error: null, taskId: "lost-task" },
      consent,
      h.services,
    );
    expect(h.services.canvas).not.toHaveBeenCalled();
    expect(h.services.credentials).toHaveBeenCalledWith(undefined, {}, undefined);
    expect(result.canvas).toBeUndefined();
    expect(result.unavailable.join(" ")).toContain("未改用其他任务");
  });
  it("keeps object-storage assets as references and resolves local results by task ID plus result index", async () => {
    const h = harness();
    h.services.localAsset = vi.fn(() =>
      Promise.resolve("https://storage.example/signed-sample.png"),
    );
    Object.assign(h.canvas, {
      linked: { kind: "local_result", generationTaskId: "source-task", resultIndex: 3 },
    });
    h.services.task = vi.fn(() =>
      Promise.resolve({
        ...h.task,
        results: [{ resultIndex: 3, finalPath: "C:\\test\\saved-result.png" }],
      }),
    );
    const result = await collectDiagnosticPayload(
      { error: null },
      { ...consent, categories: ["assets"] },
      h.services,
    );
    expect(h.services.task).toHaveBeenCalledWith("source-task");
    expect(h.services.readFile).toHaveBeenCalledWith("C:\\test\\saved-result.png");
    expect(result.assets).toContainEqual({
      name: "云端素材引用",
      mimeType: "text/uri-list",
      byteLength: 0,
      url: "https://storage.example/signed-sample.png",
    });
    expect(result.unavailable.join(" ")).toContain("未自动下载");
  });
  it("fails visibly for unreadable or oversized local materials and invalid consent", async () => {
    const h = harness();
    h.services.readFile = vi.fn(() => Promise.reject(new Error("文件不存在")));
    await expect(collectDiagnosticPayload({ error: null }, consent, h.services)).rejects.toThrow(
      "文件不存在",
    );
    h.services.readFile = vi.fn(() => Promise.resolve(new Uint8Array(48 * 1024 * 1024)));
    await expect(collectDiagnosticPayload({ error: null }, consent, h.services)).rejects.toThrow(
      "超过完整诊断包容量",
    );
    h.services.credentials = vi.fn();
    await expect(
      collectDiagnosticPayload(
        { error: null },
        { ...consent, consentConfirmed: false } as unknown as DiagnosticConsent,
        h.services,
      ),
    ).rejects.toThrow();
    expect(h.services.credentials).not.toHaveBeenCalled();
  });
  it("automatically collects all available sections without consent and records unreadable keys/materials without discarding the raw error", async () => {
    const h = harness();
    h.services.credentials = vi.fn(() => Promise.reject(new Error("凭据已删除")));
    h.services.readFile = vi.fn(() => Promise.reject(new Error("文件不存在")));
    const result = await collectDiagnosticPayload(
      { error: new Error("完整原始调用失败"), taskId: "original-task" },
      automaticDiagnosticCollection(new Date().toISOString()),
      h.services,
    );
    expect(result.collection).toMatchObject({ collectionPolicy: "automatic-complete-v1" });
    expect(result.collection).not.toHaveProperty("consentConfirmed");
    expect(JSON.stringify(result.rawResponse)).toContain("完整原始调用失败");
    expect(JSON.stringify(result.prompts)).toContain("任务冻结提示词");
    expect(result.canvas).toBeDefined();
    expect(result.assets).toContainEqual({
      name: "sample.png",
      mimeType: "image/png",
      byteLength: 4,
      dataBase64: "AAECAw==",
    });
    expect(result.unavailable.join(" ")).toMatch(/API Key.*凭据已删除/);
    expect(result.unavailable.join(" ")).toContain("文件不存在");
  });
  it("keeps ordinary prompt strings and original response spacing, redacting auth headers and known opaque keys", () => {
    expect(diagnosticContent("00123")).toBe("00123");
    expect(diagnosticContent('{  "result": "原文"  }')).toBe('{  "result": "原文"  }');
    expect(
      diagnosticContent(
        { Authorization: "opaque-selected-key", message: "echo opaque-selected-key" },
        ["opaque-selected-key"],
      ),
    ).toEqual({ Authorization: "[凭据已移除]", message: "echo [凭据已移除]" });
  });
});
