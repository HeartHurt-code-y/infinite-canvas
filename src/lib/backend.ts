import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as v from "valibot";

import {
  canvasDocumentRecordSchema,
  cloudAssetsSchema,
  connectivityTestResultSchema,
  generationCreatedEventSchema,
  generationResultReadyEventSchema,
  generationResultSavedEventSchema,
  generationRetryEventSchema,
  generationRetryExhaustedEventSchema,
  generationStateChangedEventSchema,
  generationTaskDetailSchema,
  generationTaskPageSchema,
  localAssetRecordsSchema,
  modelDefinitionsSchema,
  nullableTosStagingConfigSchema,
  optimizedPromptResultSchema,
  providerConnectionSchema,
  providerConnectionsSchema,
  providerModelBindingsSchema,
  providerTokenGroupSchema,
  providerTokenGroupsSchema,
  remoteModelOptionsSchema,
  realPersonAuthLinkSchema,
  realPersonGroupsSchema,
  stagingJobRecordSchema,
  stagingStateChangedEventSchema,
  stringSchema,
  unknownSchema,
  videoComposerEngineStatusSchema,
  videoCompositionJobRecordSchema,
  videoDownloaderEngineStatusSchema,
  videoDownloadJobRecordSchema,
  videoFrameExtractionJobRecordSchema,
} from "./backendSchemas";

export type GenerationOperation =
  "text_to_image" | "image_to_image" | "video_generation" | "text_generation";

/**
 * Canonical, provider-neutral operation schema persisted with a model definition.
 * The Rust backend validates the JSON before using it to construct a request; the
 * frontend keeps it as JSON so providers can add parameter fields without a release.
 */
export type ModelOperationSchema = Readonly<Record<string, unknown>>;

export interface ProviderConnection {
  readonly id: string;
  readonly displayName: string;
  readonly adapterId: string;
  readonly baseUrl: string;
  readonly apiKeyRef: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ModelDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly remoteModelId: string | null;
  readonly operations: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProviderModelBinding {
  readonly providerConnectionId: string;
  readonly modelDefinitionId: string;
  readonly enabledOperations: readonly GenerationOperation[];
  readonly remoteModelId: string | null;
  readonly enabled: boolean;
  /** 调用该模型使用的令牌分组；null = 供应商默认令牌（主 API Key）。 */
  readonly tokenGroup: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 供应商连接下的令牌分组：同一供应商内按令牌区分模型，各组持独立密钥。 */
export interface ProviderTokenGroup {
  readonly id: string;
  readonly providerConnectionId: string;
  readonly groupName: string;
  readonly credentialRef: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RemoteModelOption {
  readonly id: string;
  readonly modelDefinitionId: string;
  readonly displayName: string;
  readonly ownedBy: string | null;
  /** Distinguishes a never-configured model from a model the user explicitly disabled. */
  readonly hasConfiguredBinding: boolean;
  readonly configuredOperations: readonly GenerationOperation[];
  readonly suggestedOperations: readonly GenerationOperation[];
  readonly operationSchema: ModelOperationSchema;
  /** 该模型应使用的令牌分组；null = 供应商默认令牌。 */
  readonly tokenGroup: string | null;
}

export interface ProviderModelSelection {
  readonly modelDefinitionId: string;
  readonly displayName: string;
  readonly remoteModelId: string;
  readonly enabled: boolean;
  readonly enabledOperations: readonly GenerationOperation[];
  readonly operationSchema: ModelOperationSchema;
  /** 调用该模型使用的令牌分组；null = 供应商默认令牌。 */
  readonly tokenGroup: string | null;
}

/**
 * 模型定义 ID 的规范作用域格式，与后端 provider_scoped_model_definition_id 保持一致：
 * `remote::{provider_connection_id}::{remote_model_id}`。
 * 保存模型时必须使用本格式；历史数据可能把裸远程模型 ID 存为模型定义 ID，
 * 透传会触发后端「must be scoped to its provider connection」校验失败。
 */
export function providerScopedModelDefinitionId(
  providerConnectionId: string,
  remoteModelId: string,
): string {
  return `remote::${providerConnectionId}::${remoteModelId}`;
}

/**
 * 连通性测试的统一结果：ok 表示请求到达服务端并通过鉴权。
 * 失败时 reason 提供机器可读类别，detail 是服务端/网络错误的原始摘要，
 * 由 describeConnectivityTest 生成本地化提示。
 */
export interface ConnectivityTestResult {
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly elapsedMs: number;
  readonly reason: string | null;
  readonly detail: string | null;
}

/** 把连通性测试结果翻译为面向用户的中文提示，subject 如「供应商 xxx」或「对象存储」。 */
export function describeConnectivityTest(result: ConnectivityTestResult, subject: string): string {
  const elapsed = result.elapsedMs > 0 ? `，耗时 ${result.elapsedMs}ms` : "";
  if (result.ok) {
    return `${subject}连通性测试通过${elapsed}。`;
  }
  const status = result.httpStatus != null ? `（HTTP ${result.httpStatus}）` : "";
  const reason = (() => {
    switch (result.reason) {
      case "auth-rejected":
        return "凭据被拒绝，请检查密钥是否正确";
      case "bucket-not-found":
        return "桶不存在，请检查桶名和地域";
      case "redirected":
        return "请求被重定向，请确认 Endpoint、地域与桶名是否与火山引擎控制台完全一致（预签名请求不会自动跟随重定向）";
      case "network-error":
        return "网络请求失败，请检查网络连接和服务地址";
      case "not-configured":
        return "配置不完整";
      case "credential-error":
        return "读取已保存凭据失败";
      case "http-error":
        return "服务返回了错误状态";
      case null:
        return "测试失败";
      default:
        return "测试失败";
    }
  })();
  const detail = result.detail ? `（${result.detail}）` : "";
  return `${subject}连通性测试失败${status}：${reason}${detail}`;
}

export interface ConfiguredModel {
  readonly definitionId: string;
  readonly remoteModelId: string;
  readonly displayName: string;
  readonly operations: readonly GenerationOperation[];
  readonly operationSchema: ModelOperationSchema;
}

export interface ProviderCatalogEntry {
  readonly provider: ProviderConnection;
  readonly models: readonly ConfiguredModel[];
}

export interface ProviderSettingsClient {
  listProviderConnections(this: void): Promise<ProviderConnection[]>;
  upsertProviderConnection(
    this: void,
    command: {
      readonly id: string;
      readonly displayName: string;
      readonly adapterId: "moyu_v1";
      readonly baseUrl: string;
      readonly enabled: boolean;
    },
  ): Promise<ProviderConnection>;
  setCredential(
    this: void,
    command: {
      readonly credentialRef: string;
      readonly secret: string;
    },
  ): Promise<void>;
  /** 按引用名回读已保存的凭据明文，供设置界面重新打开时明文回填（用户要求持久化可见）。 */
  getCredential(this: void, credentialRef: string): Promise<string>;
  fetchProviderModels(
    this: void,
    providerConnectionId: string,
    tokenGroup?: string | null,
  ): Promise<RemoteModelOption[]>;
  listSavedProviderModels(this: void, providerConnectionId: string): Promise<RemoteModelOption[]>;
  testConnection(
    this: void,
    providerConnectionId: string,
    tokenGroup?: string | null,
  ): Promise<ConnectivityTestResult>;
  replaceProviderModelBindings(
    this: void,
    providerConnectionId: string,
    selections: readonly ProviderModelSelection[],
  ): Promise<ProviderModelBinding[]>;
  listProviderTokenGroups(this: void, providerConnectionId: string): Promise<ProviderTokenGroup[]>;
  upsertProviderTokenGroup(
    this: void,
    command: {
      readonly providerConnectionId: string;
      readonly groupName: string;
      readonly enabled: boolean;
      readonly secret?: string | null;
    },
  ): Promise<ProviderTokenGroup>;
  deleteProviderTokenGroup(
    this: void,
    providerConnectionId: string,
    groupName: string,
  ): Promise<void>;
}

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

function parseBackendPayload<TSchema extends v.GenericSchema>(
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

async function invokeDesktop<TSchema extends v.GenericSchema>(
  command: string,
  schema: TSchema,
  args?: Record<string, unknown>,
): Promise<v.InferOutput<TSchema>> {
  if (!isDesktopRuntime()) {
    throw new DesktopInvocationError(command);
  }
  const payload = await invoke<unknown>(command, args);
  return parseBackendPayload(command, schema, payload);
}

async function invokeDesktopVoid(command: string, args?: Record<string, unknown>): Promise<void> {
  await invokeDesktop(command, unknownSchema, args);
}

export const providerSettingsClient: ProviderSettingsClient = {
  listProviderConnections: () =>
    invokeDesktop("list_provider_connections", providerConnectionsSchema),
  upsertProviderConnection: (command) =>
    invokeDesktop("upsert_provider_connection", providerConnectionSchema, { command }),
  setCredential: (command) => invokeDesktopVoid("set_credential", { command }),
  getCredential: (credentialRef) =>
    invokeDesktop("get_credential", stringSchema, { credentialRef }),
  fetchProviderModels: (providerConnectionId, tokenGroup = null) =>
    invokeDesktop("fetch_provider_models", remoteModelOptionsSchema, {
      providerConnectionId,
      tokenGroup,
    }),
  listSavedProviderModels: (providerConnectionId) => loadSavedProviderModels(providerConnectionId),
  testConnection: (providerConnectionId, tokenGroup = null) =>
    invokeDesktop("test_provider_connection", connectivityTestResultSchema, {
      providerConnectionId,
      tokenGroup,
    }),
  replaceProviderModelBindings: (providerConnectionId, selections) =>
    invokeDesktop("replace_provider_model_bindings", providerModelBindingsSchema, {
      command: { providerConnectionId, selections },
    }),
  listProviderTokenGroups: (providerConnectionId) =>
    invokeDesktop("list_provider_token_groups", providerTokenGroupsSchema, {
      providerConnectionId,
    }),
  upsertProviderTokenGroup: (command) =>
    invokeDesktop("upsert_provider_token_group", providerTokenGroupSchema, { command }),
  deleteProviderTokenGroup: (providerConnectionId, groupName) =>
    invokeDesktopVoid("delete_provider_token_group", {
      command: { providerConnectionId, groupName },
    }),
};

/**
 * Restores the models a provider connection saved previously, without any network
 * access: bindings are read from the local database, joined with their definitions,
 * and mapped back into the remote-model shape the settings dialog renders.
 * Models the user explicitly disabled keep a binding row (enabled = false), so they
 * resurface as "not enabled" instead of disappearing on the next launch.
 */
async function loadSavedProviderModels(providerConnectionId: string): Promise<RemoteModelOption[]> {
  const [definitions, bindings] = await Promise.all([
    invokeDesktop("list_model_definitions", modelDefinitionsSchema),
    invokeDesktop("list_provider_model_bindings", providerModelBindingsSchema, {
      providerConnectionId,
    }),
  ]);
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));

  return bindings.flatMap((binding) => {
    const definition = definitionById.get(binding.modelDefinitionId);
    const remoteModelId = binding.remoteModelId ?? definition?.remoteModelId;
    if (!definition || !remoteModelId) return [];
    // 不信任历史 definition.id：历史版本可能把裸远程模型 ID 直接存为模型定义 ID，
    // 一律按规范作用域构造，保证保存模型时与后端校验一致。
    const modelDefinitionId = providerScopedModelDefinitionId(providerConnectionId, remoteModelId);
    return [
      {
        id: remoteModelId,
        modelDefinitionId,
        displayName: definition.displayName,
        ownedBy: null,
        hasConfiguredBinding: true,
        configuredOperations: binding.enabled ? binding.enabledOperations : [],
        suggestedOperations: [],
        operationSchema: definition.operations,
        tokenGroup: binding.tokenGroup ?? null,
      },
    ];
  });
}

export async function loadProviderCatalog(): Promise<ProviderCatalogEntry[]> {
  const [providers, definitions, bindings] = await Promise.all([
    providerSettingsClient.listProviderConnections(),
    invokeDesktop("list_model_definitions", modelDefinitionsSchema),
    invokeDesktop("list_provider_model_bindings", providerModelBindingsSchema, {
      providerConnectionId: null,
    }),
  ]);
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));

  return providers.map((provider) => ({
    provider,
    models: bindings
      .filter((binding) => binding.providerConnectionId === provider.id && binding.enabled)
      .flatMap((binding) => {
        const definition = definitionById.get(binding.modelDefinitionId);
        const remoteModelId = binding.remoteModelId ?? definition?.remoteModelId;
        if (!definition || !remoteModelId) return [];
        return [
          {
            definitionId: definition.id,
            remoteModelId,
            displayName: definition.displayName,
            operations: binding.enabledOperations,
            operationSchema: definition.operations,
          },
        ];
      }),
  }));
}

export interface TosStagingConfig {
  readonly region: string;
  readonly endpoint: string;
  readonly bucket: string;
  readonly credentialRef: string | null;
  readonly objectPrefix: string;
  readonly enabled: boolean;
}

export type StagingStatus =
  | "validating"
  | "authorizing"
  | "uploading"
  | "staged"
  | "importing"
  | "active"
  | "in_use"
  | "failed"
  | "interrupted"
  | "cleaning"
  | "cleaned";

export interface StagingAssetImportTarget {
  readonly providerConnectionId: string;
  readonly name: string | null;
  /** Positive platform group ID returned by listRealPersonGroups. Omit for ordinary assets. */
  readonly groupId?: number | null | undefined;
}

export interface StartStagingCommand {
  readonly localPath: string;
  readonly purpose: string;
  readonly mediaType: MediaType;
  readonly import?: StagingAssetImportTarget | null;
}

export interface StagingJobRecord {
  readonly id: string;
  readonly localPath: string;
  readonly purpose: string;
  readonly mediaType: MediaType;
  readonly objectKey: string | null;
  readonly status: StagingStatus;
  readonly bytesTotal: number | null;
  readonly bytesUploaded: number;
  readonly assetId: string | null;
  readonly importTarget: StagingAssetImportTarget | null;
  readonly error: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 本机 SQLite 索引中的素材；媒体正文只保存在对象存储。 */
export interface LocalAssetRecord {
  readonly id: string;
  readonly name: string;
  readonly mediaType: MediaType;
  readonly objectKey: string;
  readonly previewUrl: string;
  readonly byteSize: number;
  readonly createdAt: number;
}

export interface TosStagingClient {
  getConfig(this: void): Promise<TosStagingConfig | null>;
  configure(this: void, config: TosStagingConfig): Promise<void>;
  testConnectivity(this: void): Promise<ConnectivityTestResult>;
  setCredential(
    this: void,
    command: {
      readonly credentialRef: string;
      readonly secret: string;
    },
  ): Promise<void>;
  /** 按引用名回读已保存的凭据明文（TOS 存为 JSON），供设置界面重新打开时明文回填 AK/SK。 */
  getCredential(this: void, credentialRef: string): Promise<string>;
  startUpload(this: void, command: StartStagingCommand): Promise<string>;
  getJob(this: void, jobId: string): Promise<StagingJobRecord>;
  listLocalAssets(this: void): Promise<LocalAssetRecord[]>;
}

export const tosStagingClient: TosStagingClient = {
  getConfig: () => invokeDesktop("get_tos_staging_config", nullableTosStagingConfigSchema),
  configure: (config) => invokeDesktopVoid("configure_tos_staging", { config }),
  testConnectivity: () => invokeDesktop("test_tos_connectivity", connectivityTestResultSchema),
  setCredential: (command) => invokeDesktopVoid("set_credential", { command }),
  getCredential: (credentialRef) =>
    invokeDesktop("get_credential", stringSchema, { credentialRef }),
  startUpload: (command) => invokeDesktop("start_staging_upload", stringSchema, { command }),
  getJob: (jobId) => invokeDesktop("get_staging_job", stagingJobRecordSchema, { jobId }),
  listLocalAssets: () => invokeDesktop("list_local_assets", localAssetRecordsSchema),
};

export interface StagingStateChangedEvent {
  readonly jobId: string;
  readonly job?: StagingJobRecord | undefined;
  readonly error?: unknown;
}

export function subscribeStagingEvents(
  handler: (payload: StagingStateChangedEvent) => void,
): () => void {
  if (!isDesktopRuntime()) return () => undefined;
  const unlistenPromise = listen("staging:state-changed", (event) => {
    try {
      handler(
        parseBackendPayload(
          "event:staging:state-changed",
          stagingStateChangedEventSchema,
          event.payload,
        ),
      );
    } catch (error) {
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

/** 历史全局素材库令牌引用；仅用于兼容旧版本已保存的凭据。 */
export const ASSET_LIBRARY_CREDENTIAL_REF = "asset-library-token";

/** 素材库令牌按供应商连接隔离，避免切换 Base URL 后复用其他供应商的令牌。 */
export function assetLibraryCredentialRef(providerConnectionId: string): string {
  return `${ASSET_LIBRARY_CREDENTIAL_REF}:${providerConnectionId}`;
}

export type CloudAssetStatus = "processing" | "ready" | "failed" | "deleted" | "unknown";

export interface CloudAsset {
  readonly providerConnectionId: string;
  readonly id: string;
  readonly name: string;
  readonly kind: MediaType;
  readonly status: CloudAssetStatus;
  readonly rawStatus: string;
  readonly previewUrl: string | null;
  readonly assetUrl: string | null;
  /** 关键帧封面（视频素材的缩略图），缺失时由前端抽取视频中间帧兜底。 */
  readonly coverUrl: string | null;
  readonly groupId: number | null;
}

export interface AssetListQuery {
  readonly providerConnectionId: string;
  readonly pageNumber?: number;
  readonly pageSize?: number;
  readonly name?: string | null;
  readonly groupId?: number | null;
}

export interface RealPersonAuthLink {
  readonly h5Url: string;
  readonly tip: string | null;
}

export interface RealPersonGroup {
  /** Positive platform group ID used as the upload `groupId`. */
  readonly id: number;
  /** Upstream `group-xxx` identifier; display-only. */
  readonly remoteGroupId: string;
  readonly artistName: string;
  readonly artistDesc: string | null;
  /** Display-only timestamp; may be null while the upstream record is still synchronizing. */
  readonly authorizedAt: string | null;
  readonly assetCount: number;
}

export interface CreateRealPersonAuthLinkCommand {
  readonly providerConnectionId: string;
  readonly artistName: string;
  readonly artistDesc?: string | null;
}

export interface DeleteRealPersonAssetCommand {
  readonly providerConnectionId: string;
  /** Stable `asset-xxx` ID without the `asset://` prefix. */
  readonly id: string;
}

export interface DeleteAssetCommand {
  readonly providerConnectionId: string;
  /** Cloud `asset-xxx` ID; an `asset://` prefix is accepted and stripped. */
  readonly id: string;
}

export interface DeleteRealPersonGroupCommand {
  readonly providerConnectionId: string;
  /** Positive platform group ID, not `remoteGroupId`. */
  readonly id: number;
}

export interface AssetLibraryClient {
  list(this: void, query: AssetListQuery): Promise<CloudAsset[]>;
  /** 永久删除云端素材（上游 `POST /v1/assets/delete`），返回被删除的素材 ID。 */
  deleteAsset(this: void, command: DeleteAssetCommand): Promise<string>;
}

export interface RealPersonAssetLibraryClient {
  createRealPersonAuthLink(
    this: void,
    command: CreateRealPersonAuthLinkCommand,
  ): Promise<RealPersonAuthLink>;
  listRealPersonGroups(this: void, providerConnectionId: string): Promise<RealPersonGroup[]>;
  deleteRealPersonAsset(this: void, command: DeleteRealPersonAssetCommand): Promise<string>;
  deleteRealPersonGroup(this: void, command: DeleteRealPersonGroupCommand): Promise<void>;
}

export const assetLibraryClient: AssetLibraryClient & RealPersonAssetLibraryClient = {
  list: (query) =>
    invokeDesktop("list_assets", cloudAssetsSchema, {
      command: {
        providerConnectionId: query.providerConnectionId,
        pageNumber: query.pageNumber ?? 1,
        // 国际版素材库协议规定单页最多 100 条。
        pageSize: query.pageSize ?? 100,
        name: query.name ?? null,
        groupId: query.groupId ?? null,
      },
    }),
  deleteAsset: (command) =>
    invokeDesktop("delete_asset", stringSchema, {
      command: {
        providerConnectionId: command.providerConnectionId,
        id: command.id,
      },
    }),
  createRealPersonAuthLink: (command) =>
    invokeDesktop("create_real_person_auth_link", realPersonAuthLinkSchema, {
      command: {
        providerConnectionId: command.providerConnectionId,
        artistName: command.artistName,
        artistDesc: command.artistDesc ?? null,
      },
    }),
  listRealPersonGroups: (providerConnectionId) =>
    invokeDesktop("list_real_person_groups", realPersonGroupsSchema, {
      command: { providerConnectionId },
    }),
  deleteRealPersonAsset: (command) =>
    invokeDesktop("delete_real_person_asset", stringSchema, { command }),
  deleteRealPersonGroup: (command) => invokeDesktopVoid("delete_real_person_group", { command }),
};

const MEDIA_EXTENSION_KINDS: Record<string, MediaType> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  bmp: "image",
  avif: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  avi: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
};

export function inferMediaKindFromName(fileName: string): MediaType | null {
  // URL 也兼容：先去掉查询串（?token=...）与片段（#...），再取路径末段的扩展名。
  const pathOnly = fileName.split(/[?#]/, 1)[0] ?? "";
  const extension = pathOnly.split(".").pop()?.toLowerCase();
  if (!extension) return null;
  return MEDIA_EXTENSION_KINDS[extension] ?? null;
}

export async function pickLocalMediaFiles(): Promise<readonly string[]> {
  if (!isDesktopRuntime()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selection = await open({
    multiple: true,
    title: "选择要上传的素材文件",
    filters: [
      {
        name: "图片 / 视频 / 音频",
        extensions: Object.keys(MEDIA_EXTENSION_KINDS),
      },
    ],
  });
  if (selection == null) return [];
  return Array.isArray(selection) ? selection : [selection];
}

const PROMPT_MATERIAL_BY_EXTENSION: Readonly<
  Record<string, { readonly kind: PromptMaterialKind; readonly mimeType: string }>
> = {
  png: { kind: "image", mimeType: "image/png" },
  jpg: { kind: "image", mimeType: "image/jpeg" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  webp: { kind: "image", mimeType: "image/webp" },
  gif: { kind: "image", mimeType: "image/gif" },
  mp3: { kind: "audio", mimeType: "audio/mpeg" },
  wav: { kind: "audio", mimeType: "audio/wav" },
  m4a: { kind: "audio", mimeType: "audio/mp4" },
  aac: { kind: "audio", mimeType: "audio/aac" },
  ogg: { kind: "audio", mimeType: "audio/ogg" },
  flac: { kind: "audio", mimeType: "audio/flac" },
  mp4: { kind: "video", mimeType: "video/mp4" },
  webm: { kind: "video", mimeType: "video/webm" },
  mov: { kind: "video", mimeType: "video/quicktime" },
  mkv: { kind: "video", mimeType: "video/x-matroska" },
  pdf: { kind: "document", mimeType: "application/pdf" },
  txt: { kind: "document", mimeType: "text/plain" },
  md: { kind: "document", mimeType: "text/markdown" },
  markdown: { kind: "document", mimeType: "text/markdown" },
  json: { kind: "document", mimeType: "application/json" },
};

/**
 * 为剧本节点选择本地参考素材。只保存路径与轻量元数据，避免把大体积 Base64
 * 写进画布存档；文件字节会在用户真正发送时由 Rust 后端读取。
 */
export async function pickPromptMultimodalFiles(): Promise<readonly PickedPromptMaterial[]> {
  if (!isDesktopRuntime()) return [];
  const [{ open }, { stat }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const selection = await open({
    multiple: true,
    title: "为剧本添加参考素材",
    filters: [
      {
        name: "图片 / 音频 / 视频 / PDF / 文本",
        extensions: Object.keys(PROMPT_MATERIAL_BY_EXTENSION),
      },
    ],
  });
  if (selection == null) return [];
  const paths = Array.isArray(selection) ? selection : [selection];
  const materials = await Promise.all(
    paths.map(async (localPath): Promise<PickedPromptMaterial | null> => {
      const extension = localPath.split(".").pop()?.toLowerCase() ?? "";
      const definition = PROMPT_MATERIAL_BY_EXTENSION[extension];
      if (!definition) return null;
      const info = await stat(localPath);
      if (!info.isFile) return null;
      return {
        localPath,
        displayName: localPath.split(/[\\/]/).pop() ?? localPath,
        kind: definition.kind,
        mimeType: definition.mimeType,
        byteSize: info.size,
      };
    }),
  );
  return materials.filter((material): material is PickedPromptMaterial => material != null);
}

/**
 * 按本地文件路径解析多模态素材的类型与 MIME（与后端 expected_multimodal_mime 一致）。
 * 产物节点等已有本地文件的引用场景复用同一份映射，避免前端声明与后端校验漂移。
 */
export function promptMultimodalDefinitionForPath(
  localPath: string,
): { readonly kind: PromptMaterialKind; readonly mimeType: string } | null {
  const normalized = localPath.replace(/[\\/]/g, "/");
  const fileName = normalized.split("/").pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : "";
  return PROMPT_MATERIAL_BY_EXTENSION[extension] ?? null;
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

export type GenerationTaskStatus =
  | "created"
  | "submitting"
  | "retry_wait"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown"
  | "interrupted";

export type QueryHealth = "healthy" | "retry_wait" | "degraded";

export interface TokenUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface GenerationTaskSummary {
  readonly id: string;
  readonly canvasId: string;
  readonly sourceNodeId: string;
  readonly operation: GenerationOperation;
  readonly status: GenerationTaskStatus;
  readonly queryHealth: QueryHealth;
  readonly providerConnectionId: string;
  readonly providerDisplayNameSnapshot: string;
  readonly modelDefinitionId: string;
  readonly remoteModelIdSnapshot: string | null;
  readonly remoteTaskId: string | null;
  readonly progress: number | null;
  readonly tokens: TokenUsage | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export interface GenerationTaskListQuery {
  readonly canvasId?: string | null;
  readonly sourceNodeId?: string | null;
  readonly statuses?: readonly GenerationTaskStatus[] | null;
  readonly cursorCreatedBefore?: number | null;
  readonly limit?: number;
}

export interface GenerationTaskPage {
  readonly items: readonly GenerationTaskSummary[];
  readonly nextCursorCreatedBefore: number | null;
}

export type MediaType = "image" | "video" | "audio";

/** 生成结果记录的类型：除媒体产物外，Context-IR 等任务产出纯文本（mediaType 为 "text"）。 */
export type GenerationResultMediaType = MediaType | "text";

export type SaveStatus =
  "pending" | "writing" | "succeeded" | "failed" | "interrupted" | "local_missing" | "conflict";

export interface GenerationResultRecord {
  readonly taskId: string;
  readonly resultIndex: number;
  readonly mediaType: GenerationResultMediaType;
  readonly remoteTaskId: string | null;
  readonly source: unknown;
  readonly saveStatus: SaveStatus;
  readonly finalPath: string | null;
  readonly relativePath: string | null;
  readonly byteSize: number | null;
  readonly mimeType: string | null;
  readonly sha256: string | null;
  readonly savedAt: number | null;
  readonly error: unknown;
}

export interface ProviderCallRecord {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly phase: string;
  readonly request: unknown;
  readonly sentAt: number | null;
  readonly responseReceivedAt: number | null;
  readonly durationMs: number | null;
  readonly httpStatus: number | null;
  readonly responseHeaders: unknown;
  readonly rawResponse: string | null;
  readonly runtimeError: unknown;
}

export interface GenerationTaskDetail {
  readonly summary: GenerationTaskSummary;
  readonly logicalRequest: unknown;
  readonly resolvedRequest: unknown;
  readonly attempts: readonly unknown[];
  readonly calls: readonly ProviderCallRecord[];
  readonly events: readonly unknown[];
  readonly results: readonly GenerationResultRecord[];
  readonly textOutput: TextGenerationOutputRecord | null;
  readonly finalError: unknown;
}

export interface TextGenerationOutputRecord {
  /** 应用从模型输出中提取、实际交付给节点的提示词正文。 */
  readonly optimizedPrompt: string;
  /** 未经过围栏剥离或业务清洗的完整模型文本。 */
  readonly rawModelOutput: string;
}

export interface TextPromptSegment {
  readonly kind: "text";
  readonly text: string;
}

/** 提示词中的 @ 精确媒体引用（对齐后端 PromptSegment::MediaReference 的 serde 形状）。 */
export interface AssetMediaReferenceTarget {
  readonly kind: "asset";
  readonly providerConnectionId: string;
  readonly assetId: string;
  /** Stable identity of the repeated canvas instance, when the reference came from the canvas. */
  readonly canvasNodeKey?: string;
  /** Tauri IPC enum value; Rust deserializes MediaType with snake_case names. */
  readonly mediaType: MediaType;
}

/** 本地素材库引用：目录在本机，正文只保存在对象存储。 */
export interface LocalAssetMediaReferenceTarget {
  readonly kind: "local_asset";
  readonly stagingJobId: string;
  readonly canvasNodeKey?: string;
  readonly mediaType: MediaType;
}

export interface LocalResultMediaReferenceTarget {
  readonly kind: "local_result";
  readonly generationTaskId: string;
  readonly resultIndex: number;
  /** Stable identity of the repeated canvas instance. */
  readonly canvasNodeKey?: string;
  readonly mediaType: MediaType;
}

/** 任意本地文件引用（如视频抽帧产物）：直接读取磁盘路径。 */
export interface LocalFileMediaReferenceTarget {
  readonly kind: "local_file";
  /** 本地文件绝对路径。 */
  readonly path: string;
  /** Stable identity of the repeated canvas instance. */
  readonly canvasNodeKey?: string;
  readonly mediaType: MediaType;
}

/** 公网 http(s) URL 引用（文档/网页生视频的 file/link 素材）：直接把 URL 交给供应商抓取。
 *  仅用于显式媒体输入，不参与提示词 @ 引用（mention）系统。 */
export interface UrlMediaReferenceTarget {
  readonly kind: "url";
  /** 公网 http(s) URL，仅支持无需登录的公开页面。 */
  readonly url: string;
  /** Stable identity of the repeated canvas instance. */
  readonly canvasNodeKey?: string;
  readonly mediaType: MediaType;
}

export type ExplicitMediaTarget = MediaReferenceTarget | UrlMediaReferenceTarget;

export type MediaReferenceTarget =
  | AssetMediaReferenceTarget
  | LocalAssetMediaReferenceTarget
  | LocalResultMediaReferenceTarget
  | LocalFileMediaReferenceTarget;

export interface MediaReferencePromptSegment {
  readonly kind: "media_reference";
  readonly mentionId: string;
  readonly target: MediaReferenceTarget;
  readonly displayNameSnapshot: string;
  /** 前端按输入（连线）顺序分配的同类序号，即「图片N」中的 N。 */
  readonly typePosition?: number;
  /** 前端按输入（连线）顺序分配的全局序号，用于确定 content 数组顺序。 */
  readonly contentIndex?: number;
}

export type PromptSegment = TextPromptSegment | MediaReferencePromptSegment;

export interface ExplicitMediaInput {
  readonly target: ExplicitMediaTarget;
  readonly role: string;
  readonly displayNameSnapshot: string;
  /** 前端按输入（连线）顺序分配的同类序号，即「图片N」中的 N。 */
  readonly typePosition?: number;
  /** 前端按输入（连线）顺序分配的全局序号，用于确定 content 数组顺序。 */
  readonly contentIndex?: number;
}

export interface StartGenerationCommand {
  readonly canvasId: string;
  readonly sourceNodeId: string;
  readonly operation: GenerationOperation;
  readonly providerConnectionId: string;
  readonly modelDefinitionId: string;
  readonly prompt: readonly PromptSegment[];
  readonly explicitMedia?: readonly ExplicitMediaInput[];
  readonly parameters?: Record<string, unknown>;
  readonly generationCount?: number;
}

export interface GenerationTaskClient {
  start(this: void, command: StartGenerationCommand): Promise<string>;
  list(this: void, query: GenerationTaskListQuery): Promise<GenerationTaskPage>;
  get(this: void, taskId: string): Promise<GenerationTaskDetail>;
  queryVideoTaskNow(this: void, taskId: string): Promise<void>;
}

export const generationClient: GenerationTaskClient = {
  start: (command) => invokeDesktop("start_generation", stringSchema, { command }),
  list: (query) => invokeDesktop("list_generation_tasks", generationTaskPageSchema, { query }),
  get: (taskId) => invokeDesktop("get_generation_task", generationTaskDetailSchema, { taskId }),
  queryVideoTaskNow: (taskId) => invokeDesktopVoid("query_video_task_now", { taskId }),
};

/** 画布文档（本地 SQLite 持久化），document 为版本化的画布状态 JSON。 */
export interface CanvasDocumentRecord {
  readonly id: string;
  readonly title: string;
  readonly document: unknown;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SaveCanvasDocumentCommand {
  readonly id: string;
  readonly title: string;
  readonly document: unknown;
  readonly expectedRevision?: number | null;
}

export interface CanvasDocumentClient {
  save(this: void, command: SaveCanvasDocumentCommand): Promise<CanvasDocumentRecord>;
  get(this: void, canvasId: string): Promise<CanvasDocumentRecord>;
}

export const canvasDocumentClient: CanvasDocumentClient = {
  save: (command) => invokeDesktop("save_canvas_document", canvasDocumentRecordSchema, { command }),
  get: (canvasId) => invokeDesktop("get_canvas_document", canvasDocumentRecordSchema, { canvasId }),
};

/** 提示词优化模式：决定注入哪份提示词技能（Seedance 2.0 / 2.5、万相 3.0、MiniMax H3 或人物真实感图片）作为文本模型的系统提示词。 */
export type PromptOptimizationMode =
  "seedance_2_0" | "seedance_2_5" | "wan_3_0" | "minimax_h3" | "realistic_character";

/** 文本技能模式；文档与视频复刻模式均使用随应用编译的完整技能上下文。 */
export type TextSkillMode = PromptOptimizationMode | "screenplay" | "storyboard" | "viral_remix";

/** 文本模型请求注入系统提示词的历史上下文条目。 */
export interface PromptOptimizationContextEntry {
  readonly role: string;
  readonly content: string;
}

/**
 * 连入提示词节点、供视觉理解的图片素材（画布连线顺序即图片传入顺序）。
 * 后端会取回素材字节并以 Base64 图片内容块注入文本模型请求。
 */
export interface PromptVisionImageInput {
  /** 普通画布素材引用；与 dataUrl 二选一。 */
  readonly target?: MediaReferenceTarget;
  /** 爆款视频复刻节点在本地 WebView 生成的带时间码联系表。 */
  readonly dataUrl?: string;
  readonly displayName: string;
}

/** 剧本节点直接选择的本地多模态素材；后端在发送时读取并校验文件签名。 */
export type PromptMaterialKind = "image" | "audio" | "video" | "document";

export interface PromptMultimodalInput {
  readonly localPath: string;
  readonly displayName: string;
  readonly kind: PromptMaterialKind;
  readonly mimeType: string;
}

/** 文件选择器返回的持久化元数据；正文仍留在本地文件中，不写入画布 JSON。 */
export interface PickedPromptMaterial extends PromptMultimodalInput {
  readonly byteSize: number;
}

export interface OptimizeVideoPromptCommand {
  /** 用于把文本模型调用归档到当前画布与来源节点；旧调用方可省略。 */
  readonly canvasId?: string;
  readonly sourceNodeId?: string;
  readonly providerConnectionId: string;
  readonly modelDefinitionId: string;
  readonly mode: TextSkillMode;
  readonly userPrompt: string;
  /** 提示词节点的执行意图；旧版视频节点省略时由后端按 optimize 处理。 */
  readonly task?: "generate" | "optimize";
  readonly contextHistory?: readonly PromptOptimizationContextEntry[];
  /** 连入提示词节点的图片素材（按连线顺序）；省略时按纯文本调用。 */
  readonly visionImages?: readonly PromptVisionImageInput[];
  /** 剧本节点直接选择的图片、音频、视频或文档素材。 */
  readonly multimodalInputs?: readonly PromptMultimodalInput[];
}

export interface OptimizedPromptResult {
  /** 仅含优化后的提示词正文（后端已剥离问题分析、优化说明等无关部分）。 */
  readonly optimizedPrompt: string;
  readonly rawModelOutput: string;
}

export interface PromptNodeClient {
  run(this: void, command: OptimizeVideoPromptCommand): Promise<OptimizedPromptResult>;
}

export const promptNodeClient: PromptNodeClient = {
  run: (command) => invokeDesktop("run_prompt_node", optimizedPromptResultSchema, { command }),
};

export type GenerationEventName =
  | "generation:created"
  | "generation:state-changed"
  | "generation:result-ready"
  | "generation:result-saved"
  | "generation:retry"
  | "generation:retry-exhausted";

export interface GenerationStateChangedEvent {
  readonly taskId: string;
  readonly status: GenerationTaskStatus;
  readonly progress: number | null;
  readonly error: unknown;
}

export interface GenerationResultSavedEvent {
  readonly taskId: string;
  readonly result: GenerationResultRecord;
}

export interface GenerationResultReadyEvent {
  readonly taskId: string;
  readonly result: GenerationResultRecord;
  /** 仅用于当前会话预览；本地保存完成后由 result-saved 提供 finalPath。 */
  readonly previewSrc: string | null;
}

export interface GenerationRetryEvent {
  readonly taskId: string;
  readonly retry: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly queryOnly: boolean;
  readonly reason: unknown;
  readonly risk: string;
}

const GENERATION_EVENT_NAMES: readonly GenerationEventName[] = [
  "generation:created",
  "generation:state-changed",
  "generation:result-ready",
  "generation:result-saved",
  "generation:retry",
  "generation:retry-exhausted",
];

const GENERATION_EVENT_SCHEMAS = {
  "generation:created": generationCreatedEventSchema,
  "generation:state-changed": generationStateChangedEventSchema,
  "generation:result-ready": generationResultReadyEventSchema,
  "generation:result-saved": generationResultSavedEventSchema,
  "generation:retry": generationRetryEventSchema,
  "generation:retry-exhausted": generationRetryExhaustedEventSchema,
} as const satisfies Record<GenerationEventName, v.GenericSchema>;

export function subscribeGenerationEvents(
  handler: (eventName: GenerationEventName, payload: unknown) => void,
): () => void {
  if (!isDesktopRuntime()) return () => undefined;
  const unlistenPromises = GENERATION_EVENT_NAMES.map((name) =>
    listen(name, (event) => {
      try {
        handler(
          name,
          parseBackendPayload(`event:${name}`, GENERATION_EVENT_SCHEMAS[name], event.payload),
        );
      } catch (error) {
        frontendLog("error", formatRawBackendError(error));
      }
    }),
  );
  return () => {
    for (const promise of unlistenPromises) {
      void promise.then(
        (unlisten) => unlisten(),
        () => undefined,
      );
    }
  };
}

export function toMediaSrc(filePath: string): string {
  return isDesktopRuntime() ? convertFileSrc(filePath) : filePath;
}

export function formatBytes(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- 网络爆款视频下载（内置 yt-dlp 引擎） ----------

export type VideoDownloadStatus =
  "preparing_engine" | "downloading" | "completed" | "failed" | "cancelled";

export type VideoDownloaderEngineState = "not_installed" | "installing" | "ready" | "failed";

/** B 站画质路由：best=最高可用画质；sd480=未登录封顶 480P。 */
export type VideoDownloadQualityMode = "best" | "sd480";

export interface VideoDownloadJobRecord {
  readonly jobId: string;
  readonly url: string;
  readonly status: VideoDownloadStatus;
  /** 0-100；引擎准备阶段为 null。 */
  readonly progress: number | null;
  readonly finalPath: string | null;
  readonly fileName: string | null;
  /** 本次任务实际采用的画质路由；非 B 站为 null。 */
  readonly qualityMode: VideoDownloadQualityMode | null;
  /** 面向用户的中文画质说明（B 站下载时给出）。 */
  readonly qualityHint: string | null;
  /** B 站成片下载后是否已自动去除右上角水印（非 B 站恒为 false）。 */
  readonly watermarkRemoved: boolean;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VideoDownloaderEngineStatus {
  readonly state: VideoDownloaderEngineState;
  readonly version: string | null;
  readonly binaryPath: string | null;
  readonly cookiesInstalled: boolean;
  /** 已导入的 cookies.txt 是否含 B 站登录态（SESSDATA）。 */
  readonly bilibiliLoggedIn: boolean;
  readonly lastError: string | null;
}

export interface VideoDownloaderClient {
  getEngine: () => Promise<VideoDownloaderEngineStatus>;
  installEngine: () => Promise<VideoDownloaderEngineStatus>;
  updateEngine: () => Promise<VideoDownloaderEngineStatus>;
  importCookies: (sourcePath: string) => Promise<VideoDownloaderEngineStatus>;
  clearCookies: () => Promise<VideoDownloaderEngineStatus>;
  startDownload: (url: string) => Promise<VideoDownloadJobRecord>;
  getJob: (jobId: string) => Promise<VideoDownloadJobRecord>;
  cancelJob: (jobId: string) => Promise<VideoDownloadJobRecord>;
}

export const videoDownloaderClient: VideoDownloaderClient = {
  getEngine: () => invokeDesktop("get_video_downloader_engine", videoDownloaderEngineStatusSchema),
  installEngine: () =>
    invokeDesktop("install_video_downloader_engine", videoDownloaderEngineStatusSchema),
  updateEngine: () =>
    invokeDesktop("update_video_downloader_engine", videoDownloaderEngineStatusSchema),
  importCookies: (sourcePath) =>
    invokeDesktop("import_downloader_cookies", videoDownloaderEngineStatusSchema, { sourcePath }),
  clearCookies: () => invokeDesktop("clear_downloader_cookies", videoDownloaderEngineStatusSchema),
  startDownload: (url) =>
    invokeDesktop("start_video_download", videoDownloadJobRecordSchema, {
      command: { url },
    }),
  getJob: (jobId) =>
    invokeDesktop("get_video_download_job", videoDownloadJobRecordSchema, { jobId }),
  cancelJob: (jobId) =>
    invokeDesktop("cancel_video_download", videoDownloadJobRecordSchema, { jobId }),
};

// ---------- 画布视频抽帧（复用内置 FFmpeg 引擎） ----------

export type VideoFrameExtractionStatus =
  "preparing_engine" | "processing" | "completed" | "failed" | "cancelled";

/** 单张抽帧结果。 */
export interface ExtractedFrame {
  /** 图片文件绝对路径（桌面端经 convertFileSrc 展示）。 */
  readonly path: string;
  /** 抽取时刻（秒）。 */
  readonly timestampSeconds: number;
  readonly width: number;
  readonly height: number;
}

export interface VideoFrameExtractionJobRecord {
  readonly jobId: string;
  /** 输入视频的绝对路径。 */
  readonly videoPath: string;
  readonly status: VideoFrameExtractionStatus;
  /** 0-100；引擎准备阶段为 null。 */
  readonly progress: number | null;
  readonly frames: readonly ExtractedFrame[];
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VideoFrameExtractionClient {
  startExtraction: (
    videoPath: string,
    timestamps: readonly number[],
  ) => Promise<VideoFrameExtractionJobRecord>;
  getJob: (jobId: string) => Promise<VideoFrameExtractionJobRecord>;
  cancelJob: (jobId: string) => Promise<VideoFrameExtractionJobRecord>;
}

export const videoFrameExtractionClient: VideoFrameExtractionClient = {
  startExtraction: (videoPath, timestamps) =>
    invokeDesktop("start_video_frame_extraction", videoFrameExtractionJobRecordSchema, {
      command: { videoPath, timestamps: [...timestamps] },
    }),
  getJob: (jobId) =>
    invokeDesktop("get_video_frame_extraction_job", videoFrameExtractionJobRecordSchema, {
      jobId,
    }),
  cancelJob: (jobId) =>
    invokeDesktop("cancel_video_frame_extraction", videoFrameExtractionJobRecordSchema, {
      jobId,
    }),
};

// ---------- 画布视频合成（内置 FFmpeg 引擎） ----------

export type VideoCompositionStatus =
  "preparing_engine" | "processing" | "completed" | "failed" | "cancelled";

export type VideoComposerEngineState = "not_installed" | "installing" | "ready" | "failed";

export interface VideoComposerEngineStatus {
  readonly state: VideoComposerEngineState;
  readonly version: string | null;
  readonly binaryPath: string | null;
  readonly lastError: string | null;
}

export interface VideoCompositionJobRecord {
  readonly jobId: string;
  readonly status: VideoCompositionStatus;
  /** 0-100；引擎准备与探测阶段为 null。 */
  readonly progress: number | null;
  readonly finalPath: string | null;
  readonly fileName: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VideoCompositionInputParams {
  readonly key: string;
  readonly name: string;
  /** 本地文件绝对路径或 http(s) 远程地址。 */
  readonly source: string;
}

export interface VideoComposerClient {
  getEngine: () => Promise<VideoComposerEngineStatus>;
  installEngine: () => Promise<VideoComposerEngineStatus>;
  startComposition: (
    inputs: readonly VideoCompositionInputParams[],
    outputName: string,
  ) => Promise<VideoCompositionJobRecord>;
  getJob: (jobId: string) => Promise<VideoCompositionJobRecord>;
  cancelJob: (jobId: string) => Promise<VideoCompositionJobRecord>;
}

export const videoComposerClient: VideoComposerClient = {
  getEngine: () => invokeDesktop("get_video_composer_engine", videoComposerEngineStatusSchema),
  installEngine: () =>
    invokeDesktop("install_video_composer_engine", videoComposerEngineStatusSchema),
  startComposition: (inputs, outputName) =>
    invokeDesktop("start_video_composition", videoCompositionJobRecordSchema, {
      command: { inputs: [...inputs], outputName },
    }),
  getJob: (jobId) =>
    invokeDesktop("get_video_composition_job", videoCompositionJobRecordSchema, { jobId }),
  cancelJob: (jobId) =>
    invokeDesktop("cancel_video_composition", videoCompositionJobRecordSchema, { jobId }),
};
