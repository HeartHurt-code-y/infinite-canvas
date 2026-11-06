import {
  generationParameters,
  isFzyVideoSchema,
  isRdVideoModel,
  isSeedance20VideoModel,
  isSeedance25VideoModel,
  type ModelParameterCapability,
  type ModelParameterValue,
} from "./modelCapabilities";
import type { ModelOperationSchema } from "./backend";
import { SEEDANCE_DRAFT_PROFILE_ID } from "./seedanceDraft";
import type { PromptContentDocumentV1 } from "./promptContent";

export type SeedanceTaskMode =
  "auto" | "reference" | "first_frame" | "first_last_frame" | "edit" | "extend";

export const SEEDANCE_TASK_OPTIONS: readonly { value: SeedanceTaskMode; label: string }[] = [
  { value: "auto", label: "全参考 / 自动判断" },
  { value: "reference", label: "参考生视频" },
  { value: "first_frame", label: "首帧生视频" },
  { value: "first_last_frame", label: "首尾帧生视频" },
  { value: "edit", label: "视频编辑" },
  { value: "extend", label: "视频延长" },
];

/** Task choices express user intent; the remote service decides which requests it accepts. */
export function seedanceTaskOptions(_modelId: string): readonly {
  value: SeedanceTaskMode;
  label: string;
}[] {
  void _modelId;
  return SEEDANCE_TASK_OPTIONS;
}

interface TaskInput {
  readonly key: string;
  readonly kind: "image" | "video" | "audio";
}

/**
 * 种子任务只认媒体输入：reference_* 角色按 image/video/audio 映射，Context-IR
 * 文本素材（mediaType "text"）不参与角色映射，在入口处过滤掉。
 */
export function seedanceTaskInputs(
  inputs: readonly {
    readonly key: string;
    readonly kind: string;
  }[],
  document?: PromptContentDocumentV1 | null,
): TaskInput[] {
  const media = inputs.filter(
    (input): input is TaskInput => input.kind === "image" || input.kind === "video" || input.kind === "audio",
  );
  const keys = new Set(media.map(input => input.key));
  for (const item of document?.items ?? []) {
    if (item.kind !== "attachment" || item.mediaType === "document") continue;
    const key = item.target.canvasNodeKey ?? `attachment:${item.attachmentId}`;
    if (keys.has(key)) continue;
    keys.add(key);
    media.push({ key, kind: item.mediaType });
  }
  return media;
}

export interface SeedanceTaskSettings {
  readonly seedanceTaskMode?: SeedanceTaskMode;
  readonly parameterValues: Readonly<Record<string, ModelParameterValue>>;
  readonly mediaRoles?: Readonly<Record<string, string>>;
}

export interface SeedanceTaskState {
  readonly enabled: boolean;
  readonly mode: SeedanceTaskMode;
  readonly parameterValues: Readonly<Record<string, ModelParameterValue>>;
  readonly parameters: Record<string, ModelParameterValue>;
  readonly mediaRoles: Readonly<Record<string, string>>;
  readonly lockedParameters: readonly string[];
  readonly issue: string | null;
  readonly hint: string;
  readonly sendsExplicitTaskType: boolean;
  readonly parameterCapabilities: readonly ModelParameterCapability[];
}

function frameMode(mode: SeedanceTaskMode): boolean {
  return mode === "first_frame" || mode === "first_last_frame";
}

/** The catalog supplies controls and defaults, never an extra task-specific acceptance filter. */
export function seedanceTaskParameterCapabilities(
  _modelId: string,
  capabilities: readonly ModelParameterCapability[],
  _mode: SeedanceTaskMode,
): readonly ModelParameterCapability[] {
  void _mode;
  return capabilities;
}

function restoredMode(
  config: SeedanceTaskSettings,
  inputs: readonly TaskInput[],
): SeedanceTaskMode {
  if (SEEDANCE_TASK_OPTIONS.some((option) => option.value === config.seedanceTaskMode)) {
    return config.seedanceTaskMode!;
  }
  const roles = inputs.map((input) => config.mediaRoles?.[input.key]);
  if (roles.includes("last_frame")) return "first_last_frame";
  if (roles.includes("first_frame")) return "first_frame";
  const previous = config.parameterValues["omni_reference_task_type"];
  return previous === "reference" || previous === "edit" || previous === "extend"
    ? previous
    : "auto";
}

/** UI and submission share the task contract, including restored node settings. */
export function resolveSeedanceTask(
  modelId: string,
  capabilities: readonly ModelParameterCapability[],
  config: SeedanceTaskSettings,
  inputs: readonly TaskInput[],
  operationSchema?: ModelOperationSchema,
): SeedanceTaskState {
  const enabled = !isFzyVideoSchema(operationSchema ?? {}) && (isSeedance25VideoModel(modelId) || isSeedance20VideoModel(modelId));
  const mode = enabled ? restoredMode(config, inputs) : "auto";
  const parameterValues = { ...config.parameterValues };
  const operation = operationSchema?.["video_generation"];
  const draftEdit = mode === "edit" && parameterValues["draft"] === true &&
    operation != null && typeof operation === "object" && "requestProfileId" in operation &&
    operation["requestProfileId"] === SEEDANCE_DRAFT_PROFILE_ID;
  const mediaRoles: Record<string, string> = { ...config.mediaRoles };
  const sendsExplicitTaskType =
    enabled &&
    isSeedance25VideoModel(modelId) &&
    capabilities.some((item) => item.key === "omni_reference_task_type") &&
    !frameMode(mode) &&
    inputs.length > 0;

  if (enabled) {
    for (const input of inputs) mediaRoles[input.key] = `reference_${input.kind}`;
    if (frameMode(mode)) {
      const images = inputs.filter((input) => input.kind === "image");
      const first =
        images.find((input) => config.mediaRoles?.[input.key] === "first_frame") ?? images[0];
      const last =
        images.find(
          (input) => input.key !== first?.key && config.mediaRoles?.[input.key] === "last_frame",
        ) ?? images.find((input) => input.key !== first?.key);
      if (first) mediaRoles[first.key] = "first_frame";
      if (mode === "first_last_frame" && last) mediaRoles[last.key] = "last_frame";
    }
    // Existing dialects use this field; RD carries intent through the native videoTaskType
    // marker and prompt. Do not use the catalog enum to veto a newer server capability.
    if (sendsExplicitTaskType) parameterValues["omni_reference_task_type"] = draftEdit ? "auto" : mode;
  }

  const taskContract = enabled && isSeedance25VideoModel(modelId) && !isRdVideoModel(modelId) && !modelId.toLowerCase().includes("dreamina");
  const hasVideo = inputs.some((input) => input.kind === "video");
  const automaticVideo = hasVideo && mode === "auto";
  const followRatio = taskContract && (frameMode(mode) || mode === "edit" || mode === "extend" || automaticVideo);
  const followDuration = taskContract && (mode === "edit" || automaticVideo);
  const lockedParameters: string[] = [];
  if (followRatio) { parameterValues["ratio"] = "adaptive"; lockedParameters.push("ratio"); }
  if (followDuration) { parameterValues["duration"] = -1; lockedParameters.push("duration"); }
  const issue = taskContract && (mode === "edit" || mode === "extend") && !hasVideo
    ? "请先连接要编辑或延长的视频。" : null;
  const hint = enabled && isSeedance20VideoModel(modelId)
    ? mode === "edit" ? "Seedance 2.0 通过提示词指定编辑：请用 @ 视频引用明确原片与修改要求，时长可选 4–15 秒。"
    : mode === "extend" ? "Seedance 2.0 通过提示词指定延长：请写明向前或向后延长，并用 @ 引用区分各片段；生成时长为 4–15 秒。"
    : "Seedance 2.0 按视频上传顺序独立编号，最多 3 段且合计不超过 15 秒。可用 video_1、@video1 或 @视频1 引用。"
    : !taskContract ? "完整提交当前任务、素材和参数，由所选服务判断支持范围。"
    : mode === "edit" ? `画幅与时长跟随提示词指定的原视频（4–30 秒）；多视频时请用 @ 引用明确待编辑视频与其他素材的用途。${draftEdit ? "样片编辑由模型识别编辑意图。" : ""}`
    : mode === "extend" ? "画幅跟随待延长视频；下方时长指新增片段。请用 @ 引用指定原视频，并写明向前或向后延长。"
    : frameMode(mode) ? "画幅跟随首帧图片；时长可单独设置。"
    : automaticVideo ? "含视频时由模型判断生成、编辑或延长，使用自适应画幅和智能时长兼容这些任务。请用不同的 @ 视频引用明确各素材的用途。"
    : mode === "reference" ? "基于参考素材生成新视频，画幅与时长可设置。保留原片并局部修改时请选择「视频编辑」。可用 @视频1、@video1 或 video_1 指定素材。"
    : "参考素材按独立编号发送；可用 @视频1、@video1 或 video_1 指定素材。";

  const parameters = generationParameters(capabilities, parameterValues, inputs.length > 0);
  // A frame request is represented by media roles, and RD has no remote task-type field.
  if (enabled && !sendsExplicitTaskType) delete parameters["omni_reference_task_type"];
  return {
    enabled,
    mode,
    parameterValues,
    parameters,
    mediaRoles,
    lockedParameters,
    issue,
    hint,
    sendsExplicitTaskType,
    parameterCapabilities: capabilities,
  };
}

/** Explicit task changes may offer dialect defaults; restored requests retain user values. */
export function selectSeedanceTask<T extends SeedanceTaskSettings>(
  modelId: string,
  capabilities: readonly ModelParameterCapability[],
  config: T,
  inputs: readonly TaskInput[],
  mode: SeedanceTaskMode,
  operationSchema?: ModelOperationSchema,
): T & { readonly seedanceTaskMode: SeedanceTaskMode } {
  const next = {
    ...config,
    seedanceTaskMode: mode,
    parameterValues:
      !isFzyVideoSchema(operationSchema ?? {}) &&
      isSeedance25VideoModel(modelId) &&
      !isRdVideoModel(modelId) &&
      (mode === "auto" || frameMode(mode) || mode === "edit" || mode === "extend")
        ? {
            ...config.parameterValues,
            ratio: "adaptive",
            ...(mode === "auto" || mode === "edit" ? { duration: -1 } : {}),
          }
        : config.parameterValues,
  };
  const state = resolveSeedanceTask(modelId, capabilities, next, inputs, operationSchema);
  return { ...next, parameterValues: state.parameterValues, mediaRoles: state.mediaRoles };
}
