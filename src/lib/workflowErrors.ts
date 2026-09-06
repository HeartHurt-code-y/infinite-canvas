function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseResponse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function redact(value: string): string {
  return value
    .replace(/(\bToken[A-Za-z]*\[)[^\]]*(\])/gi, "$1<REDACTED>$2")
    .replace(/\bBearer\s+[^\s"',;<>[\]{}]+/gi, "Bearer <REDACTED>")
    .replace(/\bsk-[A-Za-z0-9_*.-]+/g, "<REDACTED>")
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*["']?)[^\s"',;<>[\]{}]+/gi,
      "$1<REDACTED>",
    )
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&#\s]+/gi, "$1<REDACTED>");
}

/** Tauri rejects with plain BackendErrorPayload objects, not JavaScript Errors. */
export function formatWorkflowError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value === "[object Object]") return;
    const text = redact(value.trim());
    if (!parts.includes(text)) parts.push(text);
  };
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 3) return;
    if (typeof value === "string") {
      add(value);
      return;
    }
    const payload = record(value);
    if (!payload || seen.has(payload)) return;
    seen.add(payload);
    add(payload["message"]);
    add(payload["source"]);
    if (typeof payload["code"] === "string" && payload["code"].trim()) {
      add(`错误码：${payload["code"]}`);
    }
    collect(payload["error"], depth + 1);
  };

  const parsed = parseResponse(error);
  collect(parsed);
  const details = record(record(parsed)?.["details"]);
  if (details) {
    const status = details["httpStatus"];
    if (typeof status === "number" || (typeof status === "string" && /^\d{3}$/.test(status))) {
      add(`HTTP ${status}`);
    }
    collect(details);
    // Read only error fields, never request headers, stack traces or full payloads.
    const response = parseResponse(details["rawResponse"]);
    if (record(response)) collect(response);
  }

  const message =
    parts.join("\n") || "工作流执行失败，未收到可读的错误信息。请在生成历史中查看详情。";
  return message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
}
