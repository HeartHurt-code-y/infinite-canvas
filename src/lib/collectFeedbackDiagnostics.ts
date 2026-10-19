import * as v from "valibot";
import { invokeDesktop } from "./ipc";
import {
  generationTaskDetailSchema,
  providerConnectionsSchema,
  providerModelBindingsSchema,
  providerTokenGroupsSchema,
} from "./backendSchemas";
import {
  bytesToBase64,
  base64ToBytes,
  diagnosticCollectionSchema,
  persistDiagnosticPayload,
  type DiagnosticCollection,
  type DiagnosticOccurrence,
  type DiagnosticPayload,
  type PreparedDiagnostics,
} from "./diagnosticAttachments";

interface CanvasContext {
  read: () => unknown;
  isActive: () => boolean;
}
const canvases = new Map<string, CanvasContext>();
export function registerDiagnosticCanvas(canvasId: string, context: CanvasContext): () => void {
  canvases.set(canvasId, context);
  return () => {
    if (canvases.get(canvasId) === context) canvases.delete(canvasId);
  };
}
const quiet = { reportErrors: false } as const;
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(
      value.startsWith("workflow-error:v1:") ? value.slice("workflow-error:v1:".length) : value,
    ) as unknown;
  } catch {
    return value;
  }
}
function walk(
  value: unknown,
  visit: (key: string, item: unknown, owner: Record<string, unknown>) => void,
  depth = 0,
): void {
  if (depth > 100) throw new Error("诊断资料结构过深，请关闭画布选项后重试。");
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1);
    return;
  }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      visit(key, item, value as Record<string, unknown>);
      walk(item, visit, depth + 1);
    }
}
function normalize(key: string) {
  return key.replace(/[^a-z]/gi, "").toLowerCase();
}
const secretFields = new Set([
  "apikey",
  "authorization",
  "cookie",
  "cookies",
  "password",
  "secret",
  "accesstoken",
  "refreshtoken",
]);
const promptFields = new Set([
  "prompt",
  "promptsegments",
  "userprompt",
  "systemprompt",
  "contexthistory",
  "conversation",
  "currentdocument",
  "composer",
  "promptcontents",
]);
function selectedContent(value: unknown, consent: DiagnosticCollection): unknown {
  if (typeof value === "string") {
    const parsed = parse(value);
    if (parsed && typeof parsed === "object") {
      const selected = selectedContent(parsed, consent);
      return JSON.stringify(selected) === JSON.stringify(parsed) ? value : JSON.stringify(selected);
    }
    return consent.categories.includes("assets")
      ? value
      : value.replace(/data:[^\s,]+;base64,[a-z0-9+/=]+/gi, "[未授权素材字节]");
  }
  if (Array.isArray(value)) return value.map((item) => selectedContent(item, consent));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        !consent.categories.includes("prompts") && promptFields.has(normalize(key))
          ? "[未授权提示词]"
          : !consent.categories.includes("assets") &&
              ["base64", "b64json", "database64", "imagebase64"].includes(normalize(key))
            ? "[未授权素材字节]"
            : !consent.categories.includes("rawResponse") &&
                ["rawresponse", "rawdebug", "responsebody"].includes(normalize(key))
              ? "[未授权原始响应]"
              : selectedContent(item, consent),
      ]),
    );
  return value;
}
function redactText(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[凭据已移除]");
  return result
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"';}]+/gi, "[凭据已移除]")
    .replace(/\b(?:sk|rk|pk)[-_][a-z0-9_-]{8,}/gi, "[密钥已移除]")
    .replace(
      /((?:api[_ -]?key|authorization|cookie|password|secret|access[_ -]?token)\s*["']?\s*[:=]\s*["']?)[^\s,;}"']+/gi,
      "$1[凭据已移除]",
    );
}
/** Credentials have their own selected section; other diagnostic sections never carry auth headers. */
export function diagnosticContent(
  value: unknown,
  secrets: readonly string[] = [],
  depth = 0,
): unknown {
  if (depth > 100) throw new Error("诊断资料结构过深，请减少附带内容后重试。");
  if (value instanceof Error)
    return diagnosticContent(
      { ...value, name: value.name, message: value.message, stack: value.stack },
      secrets,
      depth + 1,
    );
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map((item) => diagnosticContent(item, secrets, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretFields.has(normalize(key))
          ? "[凭据已移除]"
          : diagnosticContent(item, secrets, depth + 1),
      ]),
    );
  return value;
}
export interface DiagnosticCollectionServices {
  task: (id: string) => Promise<unknown>;
  canvas: (canvasId?: string) => unknown;
  credentials: (
    request: unknown,
    frozen: unknown,
    canvas: unknown,
    onError?: (label: string, error: unknown) => void,
  ) => Promise<NonNullable<DiagnosticPayload["apiKeys"]>>;
  readFile: (path: string) => Promise<Uint8Array>;
  localAsset: (id: string, mediaType: string) => Promise<string>;
}
const runtimeServices: DiagnosticCollectionServices = {
  task: (taskId) =>
    invokeDesktop("get_generation_task", generationTaskDetailSchema, { taskId }, quiet),
  canvas: (canvasId) => {
    if (canvasId) return canvases.get(canvasId)?.read();
    return [...canvases.values()].find((item) => item.isActive())?.read();
  },
  credentials: async (request, frozen, canvas, onError) => {
    const refs = new Set<string>();
    walk(frozen, (key, item) => {
      if (
        ["credentialref", "credentialreference", "apikeyref"].includes(normalize(key)) &&
        typeof item === "string" &&
        item
      )
        refs.add(item);
    });
    const source = object(object(request)["command"] ?? request);
    const providerId = source["providerConnectionId"];
    const modelId = source["modelDefinitionId"];
    const selections: { providerId: string; modelId: string }[] = [];
    if (typeof providerId === "string" && typeof modelId === "string")
      selections.push({ providerId, modelId });
    // A known historical task uses its frozen credential, never today's provider/group fallback.
    if (!frozen && !selections.length)
      walk(canvas, (_key, item) => {
        const row = object(item);
        if (typeof row["providerId"] === "string" && typeof row["modelDefinitionId"] === "string")
          selections.push({ providerId: row["providerId"], modelId: row["modelDefinitionId"] });
      });
    if (!frozen) {
      const connections = await invokeDesktop(
        "list_provider_connections",
        providerConnectionsSchema,
        undefined,
        quiet,
      );
      for (const selection of selections) {
        const connection = connections.find((item) => item.id === selection.providerId);
        if (!connection) continue;
        const bindings = await invokeDesktop(
          "list_provider_model_bindings",
          providerModelBindingsSchema,
          { providerConnectionId: connection.id },
          quiet,
        );
        const binding = bindings.find((item) => item.modelDefinitionId === selection.modelId);
        if (!binding) continue;
        if (binding.tokenGroup) {
          const groups = await invokeDesktop(
            "list_provider_token_groups",
            providerTokenGroupsSchema,
            { providerConnectionId: connection.id },
            quiet,
          );
          const group = groups.find((item) => item.groupName === binding.tokenGroup);
          if (group) refs.add(group.credentialRef);
        } else refs.add(connection.apiKeyRef);
      }
    }
    const keys: NonNullable<DiagnosticPayload["apiKeys"]> = [];
    for (const credentialRef of refs) {
      try {
        keys.push({
          providerConnectionId:
            typeof providerId === "string" ? providerId : "frozen-task-or-current-canvas",
          credentialRef,
          key: await invokeDesktop("get_credential", v.string(), { credentialRef }, quiet),
        });
      } catch (error) {
        if (!onError) throw error;
        onError(`凭据 ${credentialRef} 无法读取`, error);
      }
    }
    return keys;
  },
  readFile: async (path) => {
    const { readFile, stat } = await import("@tauri-apps/plugin-fs");
    const before = await stat(path);
    if (before.size > 48 * 1024 * 1024)
      throw new Error("诊断素材单个文件超过可用诊断包容量，请关闭素材选项或选择较小的复现素材。");
    const bytes = await readFile(path);
    const after = await stat(path);
    if (before.size !== after.size || before.mtime?.getTime() !== after.mtime?.getTime())
      throw new Error("诊断素材在准备期间发生变化，请重新准备后发送。");
    return bytes;
  },
  localAsset: (assetId, mediaType) =>
    assetId.startsWith("local-b64-")
      ? invokeDesktop("refresh_local_base64_asset_media", v.string(), { assetId, mediaType }, quiet)
      : invokeDesktop(
          "refresh_local_asset_media",
          v.string(),
          { command: { stagingJobId: assetId, mediaType } },
          quiet,
        ),
};

export async function collectDiagnosticPayload(
  occurrence: DiagnosticOccurrence,
  consent: DiagnosticCollection,
  services: DiagnosticCollectionServices = runtimeServices,
): Promise<DiagnosticPayload> {
  v.parse(diagnosticCollectionSchema, consent);
  const automatic = "collectionPolicy" in consent;
  const has = (category: DiagnosticCollection["categories"][number]) =>
    consent.categories.includes(category);
  const payload: DiagnosticPayload = {
    schemaVersion: 1,
    collection: consent,
    capturedAt: new Date().toISOString(),
    unavailable: [],
  };
  const missing = (label: string, error: unknown) => {
    if (!automatic) throw error;
    payload.unavailable.push(
      `${label}：${error instanceof Error ? error.message : "资料读取失败"}`,
    );
  };
  let task: Record<string, unknown> | undefined;
  const source = object(object(occurrence.args)["command"]);
  const taskId =
    occurrence.taskId ??
    (typeof occurrence.args?.["taskId"] === "string" ? occurrence.args["taskId"] : undefined);
  if (taskId) {
    try {
      task = object(await services.task(taskId));
    } catch {
      payload.unavailable.push("原任务详情无法读取，未改用其他任务。");
    }
  }
  const summary = object(task?.["summary"]);
  const canvasId =
    occurrence.canvasId ??
    (typeof source["canvasId"] === "string"
      ? source["canvasId"]
      : typeof summary["canvasId"] === "string"
        ? summary["canvasId"]
        : undefined);
  let canvas: unknown;
  try {
    canvas = taskId && !canvasId ? undefined : services.canvas(canvasId);
  } catch (error) {
    missing("对应画布读取失败", error);
  }
  const frozen = taskId ? (task?.["resolvedRequest"] ?? {}) : undefined;
  const request = task ? task["logicalRequest"] : occurrence.args;
  let secrets: string[] = [];
  try {
    const credentials = automatic
      ? await services.credentials(request, frozen, canvas, missing)
      : await services.credentials(request, frozen, canvas);
    secrets = credentials.map((item) => item.key);
    if (has("apiKeys")) {
      payload.apiKeys = credentials;
      if (!credentials.length)
        payload.unavailable.push("没有找到本次问题对应的凭据引用，未导出其他连接的 Key。");
    }
  } catch (error) {
    if (automatic) {
      payload.apiKeys = [];
      missing("对应 API Key 无法读取，其他诊断继续收集", error);
    } else {
      if (has("apiKeys"))
        throw new Error(
          "无法读取本次问题对应的 API Key，请检查凭据设置，或取消 API Key 选项后重试。",
          { cause: error },
        );
      // Without the selected keys, opaque credentials echoed in free text cannot be reliably removed.
      throw new Error("无法读取本次问题对应的凭据进行脱敏，请检查凭据设置后重新准备诊断。", {
        cause: error,
      });
    }
  }
  if (has("prompts")) {
    const prompts: { field: string; value: unknown }[] = [];
    walk([request, canvas], (key, item) => {
      if (promptFields.has(normalize(key)))
        prompts.push({
          field: key,
          value: selectedContent(diagnosticContent(item, secrets), consent),
        });
    });
    payload.prompts = prompts;
    if (!prompts.length) payload.unavailable.push("没有可读取的相关提示词。");
  }
  if (has("rawResponse")) {
    const calls = Array.isArray(task?.["calls"])
      ? task["calls"].map((item) => {
          return Object.fromEntries(
            Object.entries(object(item)).filter(([key]) => key !== "request"),
          );
        })
      : [];
    payload.rawResponse = selectedContent(
      diagnosticContent(
        { error: occurrence.error, calls, finalError: task?.["finalError"] },
        secrets,
      ),
      consent,
    );
  }
  if (has("canvas")) {
    if (canvas === undefined) payload.unavailable.push("对应画布当前未打开，未改用其他画布。");
    else payload.canvas = selectedContent(diagnosticContent(canvas, secrets), consent);
  }
  if (has("assets")) {
    const assets: NonNullable<DiagnosticPayload["assets"]> = [];
    const paths = new Set<string>();
    const urls = new Set<string>();
    const embedded = new Map<string, string>();
    const document = object(canvas);
    const localIds = new Map<string, { id: string; kind: string; name: string }>();
    const resultReferences = new Map<string, { taskId: string; resultIndex: number }>();
    if (Array.isArray(document["assetNodes"]))
      for (const item of document["assetNodes"]) {
        const node = object(item);
        if (
          node["source"] === "local" &&
          typeof node["assetId"] === "string" &&
          typeof node["kind"] === "string"
        )
          localIds.set(`${node["assetId"]}:${node["kind"]}`, {
            id: node["assetId"],
            kind: node["kind"],
            name: typeof node["name"] === "string" ? node["name"] : "素材",
          });
      }
    walk([request, canvas, task?.["results"]], (key, item, owner) => {
      const reference = object(item);
      if (
        reference["kind"] === "local_base64_asset" &&
        typeof reference["assetId"] === "string" &&
        typeof reference["mediaType"] === "string"
      )
        localIds.set(`${reference["assetId"]}:${reference["mediaType"]}`, {
          id: reference["assetId"],
          kind: reference["mediaType"],
          name: "引用素材",
        });
      if (
        reference["kind"] === "local_result" &&
        typeof reference["generationTaskId"] === "string" &&
        typeof reference["resultIndex"] === "number"
      )
        resultReferences.set(`${reference["generationTaskId"]}:${reference["resultIndex"]}`, {
          taskId: reference["generationTaskId"],
          resultIndex: reference["resultIndex"],
        });
      if (typeof item !== "string" || !item) return;
      if (
        ["localpath", "finalpath", "videopath", "sourcevideopath", "referenceimagepath"].includes(
          normalize(key),
        ) ||
        (key === "path" && owner["kind"] === "local_file")
      ) {
        if (/^(?:[a-z]:[\\/]|\/)/i.test(item)) paths.add(item);
      }
      if (
        ["url", "previewurl", "videourl", "asseturl"].includes(normalize(key)) &&
        /^https:\/\//i.test(item)
      )
        urls.add(item);
      if (item.startsWith("data:") && item.includes(";base64,"))
        embedded.set(
          item,
          typeof owner["name"] === "string"
            ? owner["name"]
            : typeof owner["displayName"] === "string"
              ? owner["displayName"]
              : "内嵌素材",
        );
    });
    for (const reference of resultReferences.values()) {
      try {
        const detail = object(await services.task(reference.taskId));
        const result = Array.isArray(detail["results"])
          ? detail["results"]
              .map(object)
              .find((item) => item["resultIndex"] === reference.resultIndex)
          : undefined;
        if (!result || typeof result["finalPath"] !== "string")
          throw new Error(
            "被引用的本地生成结果尚未保存或无法读取，请先保存该素材，或关闭素材选项后重试。",
          );
        paths.add(result["finalPath"]);
      } catch (error) {
        missing(`生成结果 ${reference.taskId}:${reference.resultIndex} 无法读取`, error);
      }
    }
    let totalBytes = 0;
    const addData = (name: string, dataUrl: string) => {
      const [, mimeType, data] = dataUrl.match(/^data:([^;,]+);base64,([a-z0-9+/=]+)$/i) ?? [];
      if (!mimeType || !data) throw new Error("诊断素材编码无效，请重新准备素材。");
      const length =
        Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
      if (totalBytes + length > 47 * 1024 * 1024)
        throw new Error("所选素材超过完整诊断包容量，请关闭素材选项后重试。");
      if (bytesToBase64(base64ToBytes(data)) !== data)
        throw new Error("诊断素材编码校验失败，请重新准备素材。");
      totalBytes += length;
      assets.push({ name, mimeType, byteLength: length, dataBase64: data });
    };
    for (const path of paths) {
      try {
        const bytes = await services.readFile(path);
        if (totalBytes + bytes.byteLength > 47 * 1024 * 1024)
          throw new Error("所选素材超过完整诊断包容量，请关闭素材选项后重试。");
        totalBytes += bytes.byteLength;
        assets.push({
          name: path.split(/[\\/]/).pop() ?? "素材",
          mimeType: "application/octet-stream",
          byteLength: bytes.byteLength,
          dataBase64: bytesToBase64(bytes),
        });
      } catch (error) {
        missing(`素材 ${path.split(/[\\/]/).pop() ?? "文件"} 无法读取`, error);
      }
    }
    for (const item of localIds.values()) {
      try {
        const media = await services.localAsset(item.id, item.kind);
        if (media.startsWith("data:")) addData(item.name, media);
        else if (/^https:\/\//i.test(media)) urls.add(media);
        else throw new Error("对应素材无法读取，请检查素材库后重新准备诊断。");
        embedded.delete(media);
      } catch (error) {
        missing(`素材 ${item.name} 无法读取`, error);
      }
    }
    for (const [url, name] of embedded) {
      try {
        addData(name, url);
      } catch (error) {
        missing(`内嵌素材 ${name} 无法读取`, error);
      }
    }
    for (const url of urls)
      assets.push({ name: "云端素材引用", mimeType: "text/uri-list", byteLength: 0, url });
    if (urls.size)
      payload.unavailable.push("云端素材附原始地址引用；未自动下载或请求新的生成任务。");
    if (!assets.length) payload.unavailable.push("没有找到对应的本地素材或素材地址。");
    payload.assets = assets;
  }
  return payload;
}

export async function prepareFeedbackDiagnostics(
  occurrence: DiagnosticOccurrence,
  consent: DiagnosticCollection,
): Promise<PreparedDiagnostics> {
  return persistDiagnosticPayload(await collectDiagnosticPayload(occurrence, consent));
}
