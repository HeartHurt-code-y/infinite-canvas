import { describe, expect, it } from "vitest";

import { formatWorkflowError } from "./workflowErrors";

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
