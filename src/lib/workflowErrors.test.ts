import { describe, expect, it, vi } from "vitest";

import {
  formatWorkflowError,
  formatWorkflowFailure,
  modelWorkflowError,
  workflowErrorPresentation,
  workflowStatusMessage,
  workflowUsageError,
  withWorkflowModelErrors,
} from "./workflowErrors";

describe("formatWorkflowError", () => {
  it.each(["计划解析失败，请检查模型输出。", new Error("计划解析失败，请检查模型输出。")])(
    "keeps ordinary error messages readable",
    (error) => {
      expect(formatWorkflowError(error)).toBe("计划解析失败，请检查模型输出。");
    },
  );

  it("extracts provider quota details from a JSON backend response without exposing its token", () => {
    const message = formatWorkflowError({
      kind: "protocol",
      message: "protocol error: prompt model chat completion failed",
      details: {
        httpStatus: 401,
        profile: "gemini_generate_content_v1",
        rawResponse: JSON.stringify({
          error: {
            type: "moyu_api_error",
            message:
              "该令牌额度已用尽 TokenStatusExhausted[test-token-secret] (request id: request-test)",
          },
        }),
      },
    });

    expect(message).toContain("protocol error: prompt model chat completion failed");
    expect(message).toContain("HTTP 401");
    expect(message).toContain("该令牌额度已用尽");
    expect(message).toContain("request-test");
    expect(message).not.toContain("test-token-secret");
    expect(message).not.toContain("[object Object]");
  });

  it("preserves provider error codes from an object response", () => {
    const message = formatWorkflowError({
      kind: "protocol",
      message: "prompt model chat completion failed",
      details: {
        httpStatus: 400,
        rawResponse: {
          error: { code: "model_not_found", message: "所选模型暂不可用。" },
        },
      },
    });

    expect(message).toContain("HTTP 400");
    expect(message).toContain("model_not_found");
    expect(message).toContain("所选模型暂不可用。");
  });

  it("redacts credentials in messages and omits private backend fields", () => {
    const message = formatWorkflowError({
      message:
        "请求失败 Authorization: Bearer bearer-secret; api_key=api-secret; access_token=access-secret; https://example.test?token=query-secret",
      token: "private-token",
      details: {
        httpStatus: 403,
        authorization: "private-header",
        rawResponse: JSON.stringify({
          error: { message: "credential sk-provider-secret was rejected" },
        }),
      },
    });

    expect(message).toContain("请求失败");
    expect(message).toContain("HTTP 403");
    for (const secret of [
      "bearer-secret",
      "api-secret",
      "access-secret",
      "query-secret",
      "private-token",
      "private-header",
      "sk-provider-secret",
    ]) {
      expect(message).not.toContain(secret);
    }
  });

  it.each([null, undefined, {}, { unexpected: true }, 42, "[object Object]"])(
    "returns a readable fallback for unsupported errors (%j)",
    (error) => {
      const message = formatWorkflowError(error);
      expect(message.trim()).not.toBe("");
      expect(message).not.toContain("[object Object]");
    },
  );

  it("handles circular payloads without losing an available message", () => {
    const payload: Record<string, unknown> = { message: "请求失败，请稍后重试。" };
    payload["error"] = payload;
    payload["details"] = { rawResponse: payload };

    expect(formatWorkflowError(payload)).toBe("请求失败，请稍后重试。");
  });

  it("bounds oversized error messages and does not dump unknown payloads", () => {
    const unknownPayload = { unknown: "x".repeat(20_000), token: "private-token" };
    const fallback = formatWorkflowError(unknownPayload);
    expect(fallback.length).toBeLessThanOrEqual(6000);
    expect(fallback).not.toContain("private-token");
    expect(fallback).not.toContain("x".repeat(100));
    const oversized = formatWorkflowError({ message: "请求失败。".repeat(5_000) });
    expect(oversized).toContain("请求失败。");
    expect(oversized.length).toBeLessThanOrEqual(6000);
  });
});

describe("workflow error origin and recovery guidance", () => {
  it("decodes failed status envelopes while keeping ordinary progress text intact", () => {
    expect(workflowStatusMessage("Rendering shot 2 / 5")).toBe("Rendering shot 2 / 5");
    expect(workflowStatusMessage("正在生成镜头 2 / 5")).toBe("正在生成镜头 2 / 5");
    const failed = formatWorkflowFailure(
      modelWorkflowError({
        kind: "protocol",
        message: "provider failed",
        details: { rawResponse: "error" },
      }),
    );
    expect(workflowStatusMessage(failed)).toBe("模型调用失败，完整原始报错如下。");
    expect(workflowStatusMessage("workflow-error:v1:malformed")).toBe("当前工作流步骤未能完成。");
  });
  it.each([
    ["请先确认当前工作流执行计划，再开始生成。", "查看执行计划"],
    ["工作流参考素材已修改，请按当前资料重新制作。", "重新制作"],
    ["等待封面超时，原任务已保留，可继续查询。", "确认失败前不要再次提交"],
    ["封面已生成但本地保存失败：permission denied", "恢复原任务的保存"],
    ["请选择项目内支持读图的文本模型。", "模型绑定"],
    ["镜头 2 的分镜或原曲已改变，请重新试听。", "重新制作"],
    ["原片下载失败，请检查来源。", "链接与访问条件"],
  ])("gives usable next steps for %s", (message, action) => {
    const presentation = workflowErrorPresentation(message);
    expect(presentation.origin).toBe("workflow");
    expect(presentation.summary).toBe(message);
    expect(presentation.cause).toBeTruthy();
    expect(presentation.action).toContain(action);
    expect(presentation.steps.length).toBeGreaterThan(0);
    expect(presentation.prevention).toBeTruthy();
  });

  it("does not invent a cause or treat local model configuration as a provider failure", () => {
    const unknown = workflowErrorPresentation({ kind: "unexpected", opaque: true });
    expect(unknown.summary).toBe("当前工作流步骤未能完成。");
    expect(unknown.cause).toContain("尚不足以确定具体原因");
    expect(workflowErrorPresentation(new Error("模型配置缺失，请选择模型。")).origin).toBe(
      "workflow",
    );
  });

  it("preserves the complete provider payload through retries and history serialization", () => {
    const payload = {
      kind: "protocol",
      message: "prompt model chat completion failed",
      details: {
        httpStatus: 429,
        rawResponse: {
          error: {
            message: "额度不足",
            code: "quota_exhausted",
            request_id: "request-22",
            diagnostics: "x".repeat(6000),
          },
          choices: [1, 2, 3],
        },
      },
    };
    const wrapped = new Error("策划重试失败", { cause: modelWorkflowError(payload) });
    const persisted = formatWorkflowFailure(wrapped);
    const presentation = workflowErrorPresentation(JSON.parse(JSON.stringify(persisted)));
    expect(presentation.origin).toBe("model");
    expect(presentation.cause).toBeNull();
    expect(JSON.parse(presentation.details!)).toEqual(payload);
    expect(formatWorkflowFailure(new Error(persisted))).toBe(persisted);
  });

  it("retains raw string provider errors without truncating them", () => {
    const original = `HTTP 500\n${"provider detail ".repeat(500)}`;
    expect(
      workflowErrorPresentation(formatWorkflowFailure(modelWorkflowError(original))).details,
    ).toBe(original);
  });

  it("keeps explicit usage causes and guidance after history recovery", () => {
    const original = { kind: "io", message: "permission denied", path: "output/history.db" };
    const failure = workflowUsageError("storage", "工作流历史记录保存失败。", original);
    const presentation = workflowErrorPresentation(formatWorkflowFailure(failure));
    expect(presentation.origin).toBe("workflow");
    expect(presentation.summary).toBe("工作流历史记录保存失败。");
    expect(presentation.action).toContain("磁盘空间");
    expect(JSON.parse(presentation.details!)).toMatchObject({ cause: original });
  });

  it("preserves arrays, circular references and bigint while protecting credentials", () => {
    const payload: Record<string, unknown> = {
      message: "provider failed",
      authorization: "Bearer hidden",
      token: "hidden",
      entries: [{ id: 1n }],
    };
    payload["self"] = payload;
    const details = workflowErrorPresentation(
      formatWorkflowFailure(modelWorkflowError(payload)),
    ).details!;
    expect(JSON.parse(details)).toMatchObject({
      authorization: "<REDACTED>",
      token: "<REDACTED>",
      entries: [{ id: "1" }],
      self: "[循环引用]",
    });
    expect(details).not.toContain("hidden");
  });

  it("wraps only actual model methods and preserves their receiver", async () => {
    const providerFailure = {
      kind: "protocol",
      message: "模型调用失败",
      details: { httpStatus: 500 },
    };
    const localFailure = workflowUsageError("storage", "历史记录保存失败。");
    const providerCall = vi.fn<() => Promise<never>>().mockRejectedValue(providerFailure);
    const client = {
      identity: "original-client",
      run() {
        expect(this.identity).toBe("original-client");
        return providerCall();
      },
      save() {
        return Promise.reject(localFailure);
      },
      guarded() {
        return Promise.reject(localFailure);
      },
    };
    const decorated = withWorkflowModelErrors(client, ["run", "guarded"]);
    const modelError = await decorated.run().catch((error: unknown) => error);
    expect(workflowErrorPresentation(formatWorkflowFailure(modelError)).origin).toBe("model");
    await expect(decorated.save()).rejects.toBe(localFailure);
    await expect(decorated.guarded()).rejects.toBe(localFailure);
  });

  it("leaves cancellation unchanged", async () => {
    const cancellation = new Error("cancelled");
    cancellation.name = "AbortError";
    const client = withWorkflowModelErrors(
      {
        run: () => Promise.reject(cancellation),
      },
      ["run"],
    );
    await expect(client.run()).rejects.toBe(cancellation);
  });

  it.each(["validation", "database", "io", "credential", "not_found"])(
    "keeps backend %s preflight failures local even inside a model client",
    async (kind) => {
      const payload = {
        kind,
        message: "validation error: 请先选择可用的文本模型。",
        details: { reason: "local guard" },
      };
      const client = withWorkflowModelErrors(
        {
          run: vi.fn<() => Promise<never>>().mockRejectedValue(payload),
        },
        ["run"],
      );
      const failure: unknown = await client.run().catch((error: unknown) => error);
      const presentation = workflowErrorPresentation(formatWorkflowFailure(failure));
      expect(presentation.origin).toBe("workflow");
      expect(JSON.parse(presentation.details!)).toMatchObject({ cause: payload });
    },
  );

  it("does not mistake a saved-clip note for a storage failure", () => {
    const message = "供应商请求超时，镜头 1、2 已保存。";
    const presentation = workflowErrorPresentation(message);
    expect(presentation.origin).toBe("model");
    expect(presentation.details).toBe(message);
  });

  it("uses backend origin for reference downloads inside a text-model method", async () => {
    const payload = {
      kind: "protocol",
      message: "vision reference download returned HTTP 403",
      details: {
        errorOrigin: "workflow",
        workflowErrorCode: "download",
        httpStatus: 403,
        rawResponse: "reference forbidden",
      },
    };
    const client = withWorkflowModelErrors(
      { run: vi.fn<() => Promise<never>>().mockRejectedValue(payload) },
      ["run"],
    );
    const failure: unknown = await client.run().catch((error: unknown) => error);
    const presentation = workflowErrorPresentation(formatWorkflowFailure(failure));
    expect(presentation.origin).toBe("workflow");
    expect(presentation.action).toContain("链接与访问条件");
    expect(presentation.details).toContain("reference forbidden");
  });

  it("rejects unknown persisted codes and hides opaque payloads from the summary", () => {
    const error =
      'workflow-error:v1:{"origin":"workflow","message":"{\\"opaque\\":true}","raw":"original","code":"toString"}';
    const presentation = workflowErrorPresentation(error);
    expect(presentation.summary).toBe("当前工作流步骤未能完成。");
    expect(presentation.cause).toContain("尚不足以确定具体原因");
    expect(presentation.details).toBe("original");
  });

  it.each(["toString", "constructor", "__proto__"])(
    "handles unexpected backend kind %s without inheriting a guidance entry",
    (kind) => {
      const presentation = workflowErrorPresentation({
        kind,
        message: "unexpected backend failure",
      });
      expect(presentation.origin).toBe("workflow");
      expect(presentation.steps.length).toBeGreaterThan(0);
      expect(presentation.cause).toContain("尚不足以确定具体原因");
    },
  );

  it("redacts quoted credential fields inside raw JSON response strings", () => {
    const response = JSON.stringify({
      error: { message: "failed", requestId: "request-safe" },
      api_key: "quoted-secret",
      token: "token-secret",
    });
    const direct = workflowErrorPresentation(
      formatWorkflowFailure(modelWorkflowError(response)),
    ).details!;
    expect(JSON.parse(direct)).toMatchObject({
      api_key: "<REDACTED>",
      token: "<REDACTED>",
      error: { requestId: "request-safe" },
    });
    const wrapped = {
      kind: "protocol",
      message: "provider failed",
      details: { rawResponse: response },
    };
    const details = workflowErrorPresentation(
      formatWorkflowFailure(modelWorkflowError(wrapped)),
    ).details!;
    expect(details).toContain("request-safe");
    expect(details).not.toContain("quoted-secret");
    expect(details).not.toContain("token-secret");
  });

  it("shows product-mode specific material remedies", () => {
    const presentation = workflowErrorPresentation("原图保真合成需要白底或透明底商品图。");
    expect(presentation.action).toContain("白底或透明底");
    expect(presentation.prevention).toContain("先选择制作模式");
  });
});
