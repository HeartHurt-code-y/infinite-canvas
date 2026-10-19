import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as v from "valibot";
import { captureApplicationError, captureBackendEventFailure } from "./errorReporting";

/**
 * 桌面 IPC 的唯一收口：整个前端只有这个文件直接调用 Tauri 的 `invoke` / `listen`。
 *
 * 所有命令调用必须走 `invokeDesktop` / `invokeDesktopVoid`——它们统一做三件事：
 * 1. 桌面运行时守卫：浏览器预览里直接抛出人话错误，而不是底层 internals 报错；
 * 2. 契约校验：后端返回值用 valibot schema 验证，违约时抛 `BackendContractError`
 *    （原始 payload 有意不进错误对象，防止供应商响应里的密钥经日志外泄）；
 * 3. 事件订阅走 `subscribeBackendEvent`，同样是「解析 + 失败只记日志不炸业务」。
 *
 * 业务模块不要再 `import { invoke } from "@tauri-apps/api/core"`；绕过这里等于
 * 绕过运行时守卫与契约校验（review 记录里 commerceSources 等零校验直连即前车之鉴）。
 */

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

class DesktopInvocationError extends Error {
  readonly kind = "desktop";
  readonly details: { readonly command: string; readonly runtime: "browser-preview" };

  constructor(command: string) {
    super("该连接操作只能在桌面应用中执行。");
    this.name = "DesktopInvocationError";
    this.details = { command, runtime: "browser-preview" };
  }
}

export interface BackendContractIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Raised when a successful Tauri invocation returns a payload that violates the
 * frontend/backend contract. The raw payload is deliberately omitted so secrets
 * and provider responses cannot leak into logs through error formatting.
 */
export class BackendContractError extends Error {
  readonly kind = "backend-contract";
  readonly details: {
    readonly command: string;
    readonly issues: readonly BackendContractIssue[];
  };

  constructor(command: string, issues: readonly BackendContractIssue[]) {
    const summary = issues
      .slice(0, 3)
      .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
      .join("; ");
    super(`桌面后端返回了不符合契约的数据（${command}）：${summary}`);
    this.name = "BackendContractError";
    this.details = { command, issues };
  }
}

export function parseBackendPayload<TSchema extends v.GenericSchema>(
  command: string,
  schema: TSchema,
  payload: unknown,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, payload);
  if (result.success) return result.output;
  throw new BackendContractError(
    command,
    result.issues.map((issue) => ({
      path: v.getDotPath(issue) ?? "",
      message: issue.message,
    })),
  );
}

export async function invokeDesktop<TSchema extends v.GenericSchema>(
  command: string,
  schema: TSchema,
  args?: Record<string, unknown>,
  options?: { readonly reportErrors?: boolean },
): Promise<v.InferOutput<TSchema>> {
  if (!isDesktopRuntime()) {
    throw new DesktopInvocationError(command);
  }
  // 无参数命令保持 `invoke(command)` 的一元调用形态，不传 undefined 占位。
  try {
    const payload =
      args === undefined ? await invoke<unknown>(command) : await invoke<unknown>(command, args);
    return parseBackendPayload(command, schema, payload);
  } catch (error) {
    if (options?.reportErrors !== false) captureApplicationError(error, "ipc", command, { args });
    throw error;
  }
}

export async function invokeDesktopVoid(
  command: string,
  args?: Record<string, unknown>,
): Promise<void> {
  await invokeDesktop(command, v.unknown(), args);
}

/**
 * 订阅一个后端事件：payload 过 schema 校验后交给处理器；解析失败只记日志，
 * 不把异常抛进 Tauri 的事件回调（那里无人接住，只会变成未处理异常）。
 * 返回值是同步的退订函数，订阅本身失败时退化为空操作。
 */
export function subscribeBackendEvent<TSchema extends v.GenericSchema>(
  eventName: string,
  schema: TSchema,
  onPayload: (payload: v.InferOutput<TSchema>) => void,
): () => void {
  if (!isDesktopRuntime()) return () => undefined;
  const unlistenPromise = listen(eventName, (event) => {
    try {
      const payload = parseBackendPayload(`event:${eventName}`, schema, event.payload);
      captureBackendEventFailure(eventName, payload);
      onPayload(payload);
    } catch (error) {
      captureApplicationError(error, "ipc", `event:${eventName.replaceAll("-", "_")}`);
      frontendLog("error", formatRawBackendError(error));
    }
  });
  return () => {
    void unlistenPromise.then(
      (unlisten) => unlisten(),
      () => undefined,
    );
  };
}

export type FrontendLogLevel = "info" | "warn" | "error";

/**
 * 前端结构化日志：桌面运行时通过 tauri-plugin-log 写入与后端一致的日志文件
 * （与 [staging]/[generation] 等前缀同通道，便于串联排查）；
 * 浏览器/测试环境回退到 console。日志写入失败永远静默，不影响业务流程。
 */
export function frontendLog(level: FrontendLogLevel, message: string): void {
  if (isDesktopRuntime()) {
    void (async () => {
      const pluginLog = await import("@tauri-apps/plugin-log");
      if (level === "error") {
        await pluginLog.error(message);
      } else if (level === "warn") {
        await pluginLog.warn(message);
      } else {
        await pluginLog.info(message);
      }
    })().catch(() => undefined);
    return;
  }
  // Tauri log 插件不可用（如纯浏览器调试）时的兜底输出，console 在此为有意降级。
  /* eslint-disable no-console */
  if (level === "error") {
    console.error(message);
  } else if (level === "warn") {
    console.warn(message);
  } else {
    console.info(message);
  }
  /* eslint-enable no-console */
}

export function formatRawBackendError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    return JSON.stringify(
      { ...error, name: error.name, message: error.message, stack: error.stack },
      null,
      2,
    );
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}
