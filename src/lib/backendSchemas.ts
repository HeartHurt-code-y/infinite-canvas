import * as v from "valibot";

import type {
  AssetGroupRecord,
  AssetImportOutputRecord,
  CanvasDocumentRecord,
  CanvasDocumentSummary,
  CloudAsset,
  ConnectivityTestResult,
  GenerationResultReadyEvent,
  GenerationResultRecord,
  GenerationResultSaveProgress,
  GenerationResultSavedEvent,
  GenerationRetryEvent,
  GenerationStateChangedEvent,
  GenerationTextDeltaEvent,
  GenerationTaskDetail,
  GenerationTaskPage,
  LocalAssetPage,
  LocalAssetRecord,
  MediaThumbnail,
  ModelDefinition,
  OptimizedPromptResult,
  ProviderConnection,
  ProviderModelBinding,
  ProviderTokenGroup,
  RealPersonAuthLink,
  RealPersonGroup,
  RemoteModelOption,
  RemoteVideoTaskPage,
  StagingJobRecord,
  StagingStateChangedEvent,
  TosBucketPullSummary,
  TosStagingConfig,
  VideoComposerEngineStatus,
  VideoCompositionJobRecord,
  VideoDownloadJobRecord,
  VideoDownloaderEngineStatus,
  VideoFrameExtractionJobRecord,
} from "./backend";

export const nullableStringSchema = v.nullable(v.string());
const nullableNumberSchema = v.nullable(v.number());
/** 桌面 IPC 偶发把整数编成字符串；保存进度事件必须收下，否则卡片永远不更新。 */
const ipcNumberSchema = v.pipe(
  v.union([v.number(), v.string()]),
  v.transform((value) => (typeof value === "number" ? value : Number(value))),
  v.number(),
);
const jsonObjectSchema = v.record(v.string(), v.unknown());

export const generationOperationSchema = v.picklist([
  "text_to_image",
  "image_to_image",
  "video_generation",
  "text_generation",
]);

export const providerConnectionSchema = v.looseObject({
  id: v.string(),
  displayName: v.string(),
  adapterId: v.string(),
  baseUrl: v.string(),
  apiKeyRef: v.string(),
  enabled: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<ProviderConnection>;

export const providerConnectionsSchema = v.array(providerConnectionSchema);

export const modelDefinitionSchema = v.looseObject({
  id: v.string(),
  displayName: v.string(),
  remoteModelId: nullableStringSchema,
  operations: jsonObjectSchema,
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<ModelDefinition>;

export const modelDefinitionsSchema = v.array(modelDefinitionSchema);

export const providerModelBindingSchema = v.looseObject({
  providerConnectionId: v.string(),
  modelDefinitionId: v.string(),
  enabledOperations: v.array(generationOperationSchema),
  remoteModelId: nullableStringSchema,
  enabled: v.boolean(),
  tokenGroup: nullableStringSchema,
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<ProviderModelBinding>;

export const providerModelBindingsSchema = v.array(providerModelBindingSchema);

export const providerTokenGroupSchema = v.looseObject({
  id: v.string(),
  providerConnectionId: v.string(),
  groupName: v.string(),
  credentialRef: v.string(),
  enabled: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<ProviderTokenGroup>;

export const providerTokenGroupsSchema = v.array(providerTokenGroupSchema);

export const remoteModelOptionSchema = v.looseObject({
  id: v.string(),
  modelDefinitionId: v.string(),
  displayName: v.string(),
  ownedBy: nullableStringSchema,
  hasConfiguredBinding: v.boolean(),
  configuredOperations: v.array(generationOperationSchema),
  suggestedOperations: v.array(generationOperationSchema),
  operationSchema: jsonObjectSchema,
  tokenGroup: nullableStringSchema,
}) satisfies v.GenericSchema<RemoteModelOption>;

export const remoteModelOptionsSchema = v.array(remoteModelOptionSchema);

export const connectivityTestResultSchema = v.looseObject({
  ok: v.boolean(),
  httpStatus: nullableNumberSchema,
  elapsedMs: v.number(),
  reason: nullableStringSchema,
  detail: nullableStringSchema,
}) satisfies v.GenericSchema<ConnectivityTestResult>;

export const tosStagingConfigSchema = v.looseObject({
  region: v.string(),
  endpoint: v.string(),
  bucket: v.string(),
  credentialRef: nullableStringSchema,
  objectPrefix: v.string(),
  enabled: v.boolean(),
}) satisfies v.GenericSchema<TosStagingConfig>;

export const nullableTosStagingConfigSchema = v.nullable(tosStagingConfigSchema);

const mediaTypeSchema = v.picklist(["image", "video", "audio"]);

/** 生成结果记录的类型：媒体产物之外，Context-IR 等任务产出文本（"text"）。 */
const generationResultMediaTypeSchema = v.picklist(["image", "video", "audio", "text"]);

const stagingStatusSchema = v.picklist([
  "validating",
  "authorizing",
  "uploading",
  "staged",
  "importing",
  "active",
  "in_use",
  "failed",
  "interrupted",
  "cleaning",
  "cleaned",
]);

const stagingAssetImportTargetSchema = v.looseObject({
  providerConnectionId: v.string(),
  name: nullableStringSchema,
  // 分组 ID 为字符串形态（魔芋数值 ID / 火山引擎 `asset-group-…`），缺省表示未指定分组。
  groupId: v.optional(nullableStringSchema),
});

export const stagingJobRecordSchema = v.looseObject({
  id: v.string(),
  localPath: v.string(),
  purpose: v.string(),
  mediaType: mediaTypeSchema,
  objectKey: nullableStringSchema,
  status: stagingStatusSchema,
  bytesTotal: nullableNumberSchema,
  bytesUploaded: v.number(),
  assetId: nullableStringSchema,
  importTarget: v.nullable(stagingAssetImportTargetSchema),
  // 上传前的自动调整说明（旧后端没有该字段，缺省即「未调整」）。
  adjustment: v.optional(nullableStringSchema),
  error: v.unknown(),
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<StagingJobRecord>;

export const stagingStateChangedEventSchema = v.looseObject({
  jobId: v.string(),
  job: v.optional(stagingJobRecordSchema),
  error: v.optional(v.unknown()),
}) satisfies v.GenericSchema<StagingStateChangedEvent>;

const assetImportOutputRecordSchema = v.looseObject({
  jobId: v.string(),
  localPath: v.string(),
  mediaType: mediaTypeSchema,
  status: stagingStatusSchema,
  assetId: nullableStringSchema,
  // 后端总是显式给出该字段（未指定分组时为 null）。
  groupId: nullableStringSchema,
  bytesUploaded: v.number(),
  bytesTotal: nullableNumberSchema,
  error: v.unknown(),
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<AssetImportOutputRecord>;

export const assetImportOutputRecordsSchema = v.array(assetImportOutputRecordSchema);

export const localAssetRecordSchema = v.looseObject({
  id: v.string(),
  name: v.string(),
  mediaType: mediaTypeSchema,
  objectKey: v.string(),
  previewUrl: v.string(),
  byteSize: v.number(),
  createdAt: v.number(),
}) satisfies v.GenericSchema<LocalAssetRecord>;

export const localAssetRecordsSchema = v.array(localAssetRecordSchema);

export const localAssetPageSchema = v.looseObject({
  items: localAssetRecordsSchema,
  total: v.number(),
  page: v.number(),
  pageSize: v.number(),
  kindTotals: v.looseObject({
    image: v.number(),
    video: v.number(),
    audio: v.number(),
  }),
}) satisfies v.GenericSchema<LocalAssetPage>;

export const tosBucketPullSummarySchema = v.looseObject({
  totalObjects: v.number(),
  imported: v.number(),
  skippedExisting: v.number(),
  ignoredUnsupported: v.number(),
  prefix: v.string(),
}) satisfies v.GenericSchema<TosBucketPullSummary>;

const cloudAssetStatusSchema = v.picklist(["processing", "ready", "failed", "deleted", "unknown"]);

export const cloudAssetSchema = v.looseObject({
  providerConnectionId: v.string(),
  id: v.string(),
  name: v.string(),
  kind: mediaTypeSchema,
  status: cloudAssetStatusSchema,
  rawStatus: v.string(),
  previewUrl: nullableStringSchema,
  assetUrl: nullableStringSchema,
  coverUrl: nullableStringSchema,
  groupId: nullableStringSchema,
}) satisfies v.GenericSchema<CloudAsset>;

export const cloudAssetsSchema = v.array(cloudAssetSchema);

/** 云端素材按类型计数（后端扫描全部页后得到，与本地素材计数同形）。 */
export const cloudAssetKindTotalsSchema = v.looseObject({
  image: v.number(),
  video: v.number(),
  audio: v.number(),
});

export const assetGroupSchema = v.looseObject({
  id: v.string(),
  /** 纯展示名（上游已去除令牌前缀），前端只展示该字段。 */
  name: v.string(),
  /** 带 `user-{uid}-token-{tid}-` 前缀的全名，仅用于诊断。 */
  groupName: v.string(),
  isDefault: v.boolean(),
  assetCount: v.number(),
}) satisfies v.GenericSchema<AssetGroupRecord>;

export const assetGroupsSchema = v.array(assetGroupSchema);

export const realPersonAuthLinkSchema = v.looseObject({
  h5Url: v.string(),
  tip: nullableStringSchema,
}) satisfies v.GenericSchema<RealPersonAuthLink>;

export const realPersonGroupSchema = v.looseObject({
  id: v.number(),
  remoteGroupId: v.string(),
  artistName: v.string(),
  artistDesc: nullableStringSchema,
  authorizedAt: nullableStringSchema,
  assetCount: v.number(),
}) satisfies v.GenericSchema<RealPersonGroup>;

export const realPersonGroupsSchema = v.array(realPersonGroupSchema);

const generationTaskStatusSchema = v.picklist([
  "created",
  "submitting",
  "retry_wait",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "interrupted",
]);

const queryHealthSchema = v.picklist(["healthy", "retry_wait", "degraded"]);

const tokenUsageSchema = v.looseObject({
  promptTokens: nullableNumberSchema,
  completionTokens: nullableNumberSchema,
  totalTokens: nullableNumberSchema,
});

const generationTaskSummarySchema = v.looseObject({
  id: v.string(),
  canvasId: v.string(),
  sourceNodeId: v.string(),
  operation: generationOperationSchema,
  status: generationTaskStatusSchema,
  queryHealth: queryHealthSchema,
  providerConnectionId: v.string(),
  providerDisplayNameSnapshot: v.string(),
  modelDefinitionId: v.string(),
  remoteModelIdSnapshot: nullableStringSchema,
  remoteTaskId: nullableStringSchema,
  progress: nullableNumberSchema,
  tokens: v.nullable(tokenUsageSchema),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: nullableNumberSchema,
});

export const generationTaskPageSchema = v.looseObject({
  items: v.array(generationTaskSummarySchema),
  nextCursorCreatedBefore: nullableNumberSchema,
}) satisfies v.GenericSchema<GenerationTaskPage>;

export const remoteVideoTaskPageSchema = v.looseObject({
  page: v.pipe(v.number(), v.integer(), v.minValue(1)),
  pageSize: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  total: v.pipe(v.number(), v.integer(), v.minValue(0)),
  items: v.array(
    v.looseObject({
      taskId: v.string(),
      submitTime: v.number(),
      startTime: v.number(),
      finishTime: v.number(),
      status: v.string(),
      progress: v.string(),
      videoUrl: nullableStringSchema,
      failureReason: nullableStringSchema,
      promptTokens: v.number(),
      completionTokens: v.number(),
      localTaskId: nullableStringSchema,
      localTaskStatus: v.nullable(generationTaskStatusSchema),
      canResumePolling: v.boolean(),
    }),
  ),
}) satisfies v.GenericSchema<RemoteVideoTaskPage>;

export const generationResultRecordSchema = v.looseObject({
  taskId: v.string(),
  resultIndex: v.number(),
  mediaType: generationResultMediaTypeSchema,
  remoteTaskId: nullableStringSchema,
  source: v.unknown(),
  saveStatus: v.picklist([
    "pending",
    "writing",
    "succeeded",
    "failed",
    "interrupted",
    "local_missing",
    "conflict",
  ]),
  finalPath: nullableStringSchema,
  relativePath: nullableStringSchema,
  byteSize: nullableNumberSchema,
  mimeType: nullableStringSchema,
  sha256: nullableStringSchema,
  savedAt: nullableNumberSchema,
  error: v.unknown(),
}) satisfies v.GenericSchema<GenerationResultRecord>;

const providerCallRecordSchema = v.looseObject({
  id: v.string(),
  taskId: v.string(),
  attemptId: v.string(),
  phase: v.string(),
  request: v.unknown(),
  sentAt: nullableNumberSchema,
  responseReceivedAt: nullableNumberSchema,
  durationMs: nullableNumberSchema,
  httpStatus: nullableNumberSchema,
  responseHeaders: v.unknown(),
  rawResponse: nullableStringSchema,
  runtimeError: v.unknown(),
});

const textGenerationOutputRecordSchema = v.looseObject({
  optimizedPrompt: v.string(),
  rawModelOutput: v.string(),
});

export const generationTaskDetailSchema = v.looseObject({
  summary: generationTaskSummarySchema,
  logicalRequest: v.unknown(),
  resolvedRequest: v.unknown(),
  attempts: v.array(v.unknown()),
  calls: v.array(providerCallRecordSchema),
  events: v.array(v.unknown()),
  results: v.array(generationResultRecordSchema),
  textOutput: v.nullable(textGenerationOutputRecordSchema),
  finalError: v.unknown(),
}) satisfies v.GenericSchema<GenerationTaskDetail>;

export const canvasDocumentRecordSchema = v.looseObject({
  id: v.string(),
  title: v.string(),
  document: v.unknown(),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<CanvasDocumentRecord>;

export const canvasDocumentSummarySchema = v.looseObject({
  id: v.string(),
  title: v.string(),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<CanvasDocumentSummary>;

export const canvasDocumentSummariesSchema = v.array(canvasDocumentSummarySchema);

export const optimizedPromptResultSchema = v.looseObject({
  optimizedPrompt: v.string(),
  rawModelOutput: v.string(),
}) satisfies v.GenericSchema<OptimizedPromptResult>;

export const generationCreatedEventSchema = v.looseObject({
  taskId: v.string(),
  sourceNodeId: v.string(),
});

export const generationStateChangedEventSchema = v.looseObject({
  taskId: v.string(),
  status: generationTaskStatusSchema,
  progress: nullableNumberSchema,
  error: v.unknown(),
}) satisfies v.GenericSchema<GenerationStateChangedEvent>;

export const generationTextDeltaEventSchema = v.looseObject({
  taskId: v.string(),
  sourceNodeId: v.string(),
  canvasId: v.string(),
  delta: v.string(),
}) satisfies v.GenericSchema<GenerationTextDeltaEvent>;

export const generationResultSavedEventSchema = v.looseObject({
  taskId: v.string(),
  result: generationResultRecordSchema,
}) satisfies v.GenericSchema<GenerationResultSavedEvent>;

export const generationResultReadyEventSchema = v.looseObject({
  taskId: v.string(),
  result: generationResultRecordSchema,
  previewSrc: nullableStringSchema,
}) satisfies v.GenericSchema<GenerationResultReadyEvent>;

export const generationResultSaveProgressEventSchema = v.pipe(
  v.looseObject({
    taskId: v.string(),
    resultIndex: ipcNumberSchema,
    received: ipcNumberSchema,
    total: v.optional(v.nullable(ipcNumberSchema)),
    bytesPerSec: v.optional(v.nullable(ipcNumberSchema)),
  }),
  v.transform((value): GenerationResultSaveProgress => ({
    taskId: value.taskId,
    resultIndex: value.resultIndex,
    received: value.received,
    total: value.total ?? null,
    bytesPerSec: Number.isFinite(value.bytesPerSec ?? Number.NaN) ? Number(value.bytesPerSec) : 0,
  })),
) satisfies v.GenericSchema<GenerationResultSaveProgress>;

export const generationRetryEventSchema = v.looseObject({
  taskId: v.string(),
  retry: v.number(),
  maxRetries: v.number(),
  delayMs: v.number(),
  queryOnly: v.boolean(),
  reason: v.unknown(),
  risk: v.string(),
}) satisfies v.GenericSchema<GenerationRetryEvent>;

export const generationRetryExhaustedEventSchema = v.looseObject({
  taskId: v.string(),
  maxRetries: v.number(),
  reason: v.unknown(),
});

const videoDownloadStatusSchema = v.picklist([
  "preparing_engine",
  "downloading",
  "completed",
  "failed",
  "cancelled",
]);

export const videoDownloadJobRecordSchema = v.looseObject({
  jobId: v.string(),
  url: v.string(),
  status: videoDownloadStatusSchema,
  progress: nullableNumberSchema,
  finalPath: nullableStringSchema,
  fileName: nullableStringSchema,
  qualityMode: v.nullable(v.picklist(["best", "sd480"])),
  qualityHint: nullableStringSchema,
  watermarkRemoved: v.boolean(),
  error: nullableStringSchema,
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<VideoDownloadJobRecord>;

export const videoDownloaderEngineStatusSchema = v.looseObject({
  state: v.picklist(["not_installed", "installing", "ready", "failed"]),
  version: nullableStringSchema,
  binaryPath: nullableStringSchema,
  cookiesInstalled: v.boolean(),
  bilibiliLoggedIn: v.boolean(),
  lastError: nullableStringSchema,
}) satisfies v.GenericSchema<VideoDownloaderEngineStatus>;

export const videoCompositionJobRecordSchema = v.looseObject({
  jobId: v.string(),
  status: v.picklist(["preparing_engine", "processing", "completed", "failed", "cancelled"]),
  progress: nullableNumberSchema,
  finalPath: nullableStringSchema,
  fileName: nullableStringSchema,
  width: nullableNumberSchema,
  height: nullableNumberSchema,
  durationSeconds: nullableNumberSchema,
  error: nullableStringSchema,
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<VideoCompositionJobRecord>;

export const videoComposerEngineStatusSchema = v.looseObject({
  state: v.picklist(["not_installed", "installing", "ready", "failed"]),
  version: nullableStringSchema,
  binaryPath: nullableStringSchema,
  lastError: nullableStringSchema,
}) satisfies v.GenericSchema<VideoComposerEngineStatus>;

export const mediaThumbnailSchema = v.looseObject({
  path: v.string(),
  width: v.number(),
  height: v.number(),
}) satisfies v.GenericSchema<MediaThumbnail>;

export const nullableMediaThumbnailSchema = v.nullable(mediaThumbnailSchema);

export const videoFrameExtractionJobRecordSchema = v.looseObject({
  jobId: v.string(),
  videoPath: v.string(),
  status: v.picklist(["preparing_engine", "processing", "completed", "failed", "cancelled"]),
  progress: nullableNumberSchema,
  frames: v.array(
    v.looseObject({
      path: v.string(),
      timestampSeconds: v.number(),
      width: v.number(),
      height: v.number(),
    }),
  ),
  error: nullableStringSchema,
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<VideoFrameExtractionJobRecord>;

export const stringSchema = v.string();
export const unknownSchema = v.unknown();
