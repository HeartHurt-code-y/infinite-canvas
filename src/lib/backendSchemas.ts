import * as v from "valibot";

import type {
  CanvasDocumentRecord,
  CloudAsset,
  ConnectivityTestResult,
  GenerationResultReadyEvent,
  GenerationResultRecord,
  GenerationResultSavedEvent,
  GenerationRetryEvent,
  GenerationStateChangedEvent,
  GenerationTaskDetail,
  GenerationTaskPage,
  LocalAssetRecord,
  ModelDefinition,
  OptimizedPromptResult,
  ProviderConnection,
  ProviderModelBinding,
  RealPersonAuthLink,
  RealPersonGroup,
  RemoteModelOption,
  StagingJobRecord,
  StagingStateChangedEvent,
  TosStagingConfig,
  VideoComposerEngineStatus,
  VideoCompositionJobRecord,
  VideoDownloadJobRecord,
  VideoDownloaderEngineStatus,
} from "./backend";

const nullableStringSchema = v.nullable(v.string());
const nullableNumberSchema = v.nullable(v.number());
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
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<ProviderModelBinding>;

export const providerModelBindingsSchema = v.array(providerModelBindingSchema);

export const remoteModelOptionSchema = v.looseObject({
  id: v.string(),
  modelDefinitionId: v.string(),
  displayName: v.string(),
  ownedBy: nullableStringSchema,
  hasConfiguredBinding: v.boolean(),
  configuredOperations: v.array(generationOperationSchema),
  suggestedOperations: v.array(generationOperationSchema),
  operationSchema: jsonObjectSchema,
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
  groupId: v.optional(nullableNumberSchema),
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
  error: v.unknown(),
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<StagingJobRecord>;

export const stagingStateChangedEventSchema = v.looseObject({
  jobId: v.string(),
  job: v.optional(stagingJobRecordSchema),
  error: v.optional(v.unknown()),
}) satisfies v.GenericSchema<StagingStateChangedEvent>;

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
  groupId: nullableNumberSchema,
}) satisfies v.GenericSchema<CloudAsset>;

export const cloudAssetsSchema = v.array(cloudAssetSchema);

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

export const generationResultRecordSchema = v.looseObject({
  taskId: v.string(),
  resultIndex: v.number(),
  mediaType: mediaTypeSchema,
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

export const generationResultSavedEventSchema = v.looseObject({
  taskId: v.string(),
  result: generationResultRecordSchema,
}) satisfies v.GenericSchema<GenerationResultSavedEvent>;

export const generationResultReadyEventSchema = v.looseObject({
  taskId: v.string(),
  result: generationResultRecordSchema,
  previewSrc: nullableStringSchema,
}) satisfies v.GenericSchema<GenerationResultReadyEvent>;

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
  error: nullableStringSchema,
  createdAt: v.number(),
  updatedAt: v.number(),
}) satisfies v.GenericSchema<VideoDownloadJobRecord>;

export const videoDownloaderEngineStatusSchema = v.looseObject({
  state: v.picklist(["not_installed", "installing", "ready", "failed"]),
  version: nullableStringSchema,
  binaryPath: nullableStringSchema,
  cookiesInstalled: v.boolean(),
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

export const stringSchema = v.string();
export const unknownSchema = v.unknown();
