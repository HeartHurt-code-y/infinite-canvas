/**
 * 后端报错的可读化：把 Tauri 的错误载荷还原成一句人话，同时抹掉凭据。
 *
 * 只做两件事，不做别的判断：
 *   1. 从载荷里取出真正的错误文本（消息、错误码、HTTP 状态），不让
 *      `[object Object]` 或整段 JSON 冒到界面上；
 *   2. 抹掉 API Key、Token、Authorization 等敏感片段，避免写进日志或截图。
 *
 * 界面上真正展示什么，由 ErrorAlert 决定；这里只负责产出可展示的文本。
 */
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

/**
 * 解析一段「序列化过的错误文本」，取出里面的错误载荷。
 *
 * 后端错误有三种落法：Tauri 的 `{kind, message, details}` 载荷对象、被
 * `formatRawBackendError` 摊平的 JSON 文本（`{name, message, stack}`），以及
 * 普通句子。前两种都能还原出 `message`，第三种本来就该直接显示。少了这一步，
 * 摊平过的 Error 会整坨 JSON 落回界面——用户看到的是 `{"name":"Error",…}`，
 * 而不是「这张图为什么不能用」。
 */
export function errorPayloadFromText(value: string): Record<string, unknown> | null {
  const parsed = record(parseResponse(value));
  if (!parsed) return null;
  return typeof parsed["message"] === "string" ? parsed : null;
}

/**
 * 判断一段文本是不是「序列化过的错误载荷」。
 *
 * 这类文本不能直接当人话显示：它要么是没被还原的 JSON，要么是原始报文。
 * 认不出来时宁可给一句兜底提示，也不要把 JSON 印在界面上。
 */
export function looksLikeSerializedError(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function redact(value: string): string {
  return value
    .replace(
      /("(?:api[_-]?key|access[_-]?token|authorization|token|password|secret|[A-Za-z0-9_-]*(?:signature|credential|security[-_]?token))"\s*:\s*")((?:\\.|[^"\\])*)(")/gi,
      "$1<REDACTED>$3",
    )
    .replace(/(\bToken[A-Za-z]*\[)[^\]]*(\])/gi, "$1<REDACTED>$2")
    .replace(/\bBearer\s+[^\s"',;<>[\]{}]+/gi, "Bearer <REDACTED>")
    .replace(/\bsk-[A-Za-z0-9_*.-]+/g, "<REDACTED>")
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*["']?)[^\s"',;<>[\]{}]+/gi,
      "$1<REDACTED>",
    )
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&#\s]+/gi, "$1<REDACTED>")
    /*
     * 对象存储的预签名参数。
     *
     * 素材直链是短期有效的凭据：`X-Tos-Signature` / `X-Tos-Credential` /
     * `X-Tos-Security-Token`（火山引擎 TOS）与 `X-Amz-Signature` 等（AWS 风格）。
     *
     * 参数名的判定必须**足够具体**，否则会误伤普通文本：
     * 之前那条 `[A-Za-z0-9_-]*(?:Signature|Credential|...)` 会把
     * 「Signature: approved by the user」这种正常英文句子抹掉后半截。
     *
     * 现在的规则：
     *   1. 查询串形态：`?X-Tos-Signature=…`（`&` 分隔，值到 `&`/`#`/空白为止）；
     *   2. 键值形态：参数名**必须带前缀分隔符**（`X-Tos-` / `x_amz_` 这类），
     *      或整体就是 `security_token` / `security-token`。
     *      单纯的英文单词（signature / credential）不算参数名，不会被抹。
     *   3. JSON 键形态：由上面第一条正则统一覆盖（键名可带前缀）。
     */
    .replace(
      /([?&][A-Za-z0-9_-]*(?:signature|credential|security[-_]?token)=)[^&#\s]+/gi,
      "$1<REDACTED>",
    )
    .replace(
      /((?:(?:[A-Za-z0-9]+[-_])+(?:signature|credential)|(?:security[-_]?token))\s*[:=]\s*["']?)[^\s"',;<>[\]{}]+/gi,
      "$1<REDACTED>",
    );
}

/** Some gateways put a serialized upstream error, including echoed inputs, in error.message. */
export function providerResponseErrorMessage(response: unknown, status: unknown): string | null {
  const body = record(parseResponse(response));
  const envelope = record(body?.["error"]);
  const detail = record(parseResponse(envelope?.["message"]));
  const message = detail?.["errorMessage"];
  if (typeof message !== "string" || !message.trim() || looksLikeSerializedError(message)) {
    return null;
  }
  const code = detail?.["errorCode"];
  const labels: string[] = [];
  if ((typeof status === "number" || typeof status === "string") && /^\d{3}$/.test(String(status))) {
    labels.push(`HTTP ${status}`);
  }
  if ((typeof code === "number" || typeof code === "string") && /^[\w.-]{1,64}$/.test(String(code))) {
    labels.push(`错误码 ${code}`);
  }
  const suffix = labels.length ? `（${labels.join("，")}）` : "";
  const reason = redact(message.trim());
  if (String(code) === "1007" && reason.toLowerCase() === "failed to parse request body") {
    return `供应商无法解析请求体${suffix}。若使用了大参考图，可启用对象存储直连（TOS）或改用公网图片链接。`;
  }
  return `${reason.slice(0, 1000)}${suffix}`;
}

/**
 * 旧版持久化失败信封的前缀。
 *
 * 工作流功能已移除，现在不再产生新信封；保留解析是为了让旧画布与旧任务记录里
 * 已写入的失败文本仍能还原成可读诊断，而不是退化成一段裸 JSON。
 */
export const LEGACY_ERROR_ENVELOPE_PREFIX = "workflow-error:v1:";

/** 旧版持久化失败信封的前缀；只读不写，保留是为了旧记录仍能读出原句。 */
const ERROR_PREFIX = LEGACY_ERROR_ENVELOPE_PREFIX;

interface PersistedError {
  readonly message: string;
}

function persistedError(value: unknown): PersistedError | null {
  if (typeof value !== "string" || !value.startsWith(ERROR_PREFIX)) return null;
  const parsed = record(parseResponse(value.slice(ERROR_PREFIX.length)));
  if (!parsed || typeof parsed["message"] !== "string") return null;
  return { message: redact(parsed["message"]) };
}

/** Tauri rejects with plain BackendErrorPayload objects, not JavaScript Errors. */
export function formatErrorMessage(error: unknown): string {
  const persisted = persistedError(error) ?? persistedError(record(error)?.["message"]);
  if (persisted) return persisted.message;
  const parsed = parseResponse(error);
  const details = record(record(parsed)?.["details"]);
  const providerMessage = providerResponseErrorMessage(details?.["rawResponse"], details?.["httpStatus"]);
  if (providerMessage) return providerMessage;
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

  collect(parsed);
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

  const message = parts.join("\n") || "操作失败，未收到可读的错误信息。请在生成历史中查看详情。";
  return message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
}
