import {
  generationParameters,
  isRdVideoModel,
  isSeedance25VideoModel,
  type ModelParameterCapability,
  type ModelParameterValue,
} from "./modelCapabilities";

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

/** Compile task roles without rejecting media or replacing explicit remote parameter choices. */
export function resolveSeedanceTask(
  modelId: string,
  capabilities: readonly ModelParameterCapability[],
  config: SeedanceTaskSettings,
  inputs: readonly TaskInput[],
): SeedanceTaskState {
  const enabled = isSeedance25VideoModel(modelId);
  const mode = enabled ? restoredMode(config, inputs) : "auto";
  const parameterValues = { ...config.parameterValues };
  const mediaRoles: Record<string, string> = { ...config.mediaRoles };
  const sendsExplicitTaskType =
    enabled &&
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
    if (sendsExplicitTaskType) parameterValues["omni_reference_task_type"] = mode;
  }

  const parameters = generationParameters(capabilities, parameterValues, inputs.length > 0);
  // A frame request is represented by media roles, and RD has no remote task-type field.
  if (enabled && !sendsExplicitTaskType) delete parameters["omni_reference_task_type"];
  return {
    enabled,
    mode,
    parameterValues,
    parameters,
    mediaRoles,
    lockedParameters: [],
    issue: null,
    hint: "完整提交当前任务、素材和参数；模型支持范围及素材数量、时长限制由服务端返回。",
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
): T & { readonly seedanceTaskMode: SeedanceTaskMode } {
  const next = {
    ...config,
    seedanceTaskMode: mode,
    parameterValues:
      !isRdVideoModel(modelId) &&
      (mode === "auto" || frameMode(mode) || mode === "edit" || mode === "extend")
        ? {
            ...config.parameterValues,
            ratio: "adaptive",
            ...(mode === "auto" || mode === "edit" ? { duration: -1 } : {}),
          }
        : config.parameterValues,
  };
  const state = resolveSeedanceTask(modelId, capabilities, next, inputs);
  return { ...next, parameterValues: state.parameterValues, mediaRoles: state.mediaRoles };
}
