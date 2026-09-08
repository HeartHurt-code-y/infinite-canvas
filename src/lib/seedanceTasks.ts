import {
  generationParameters,
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

function capabilityAllowsValue(
  capability: ModelParameterCapability,
  value: ModelParameterValue,
): boolean {
  if (capability.type === "boolean" && typeof value !== "boolean") return false;
  if (capability.type === "string" && typeof value !== "string") return false;
  if (capability.type === "integer" || capability.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (capability.type === "integer" && !Number.isInteger(value)) return false;
    if (capability.minimum != null && value < capability.minimum) return false;
    if (capability.maximum != null && value > capability.maximum) return false;
  }
  return (
    capability.options.length === 0 || capability.options.some((option) => option.value === value)
  );
}

/** Task limits narrow the provider's declared capabilities; they never add unsupported values. */
export function seedanceTaskParameterCapabilities(
  modelId: string,
  capabilities: readonly ModelParameterCapability[],
  mode: SeedanceTaskMode,
): readonly ModelParameterCapability[] {
  if (
    !isSeedance25VideoModel(modelId) ||
    !(frameMode(mode) || mode === "edit" || mode === "extend")
  )
    return capabilities;
  const durations =
    mode === "edit" ? [-1] : [-1, ...Array.from({ length: 27 }, (_, index) => index + 4)];
  return capabilities.map((capability) => {
    if (capability.key !== "duration") return capability;
    const allowed = durations.filter((value) => capabilityAllowsValue(capability, value));
    const options =
      capability.options.length > 0
        ? capability.options.filter(
            (option) => typeof option.value === "number" && allowed.includes(option.value),
          )
        : allowed.map((value) => ({ value, label: value === -1 ? "智能时长" : `${value} 秒` }));
    return {
      ...capability,
      options,
      defaultValue: options.some((option) => option.value === capability.defaultValue)
        ? capability.defaultValue
        : (options[0]?.value ?? ""),
    };
  });
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

/** One contract for visible settings and actual submission, including restored canvases. */
export function resolveSeedanceTask(
  modelId: string,
  capabilities: readonly ModelParameterCapability[],
  config: SeedanceTaskSettings,
  inputs: readonly TaskInput[],
): SeedanceTaskState {
  const enabled = isSeedance25VideoModel(modelId);
  const mode = enabled ? restoredMode(config, inputs) : "auto";
  const parameterCapabilities = seedanceTaskParameterCapabilities(modelId, capabilities, mode);
  const parameterValues = { ...config.parameterValues };
  const mediaRoles: Record<string, string> = { ...config.mediaRoles };
  const lockedParameters: string[] = [];
  let issue: string | null = null;
  let hint = "";
  const taskCapability = capabilities.find((item) => item.key === "omni_reference_task_type");
  const requestsExplicitTaskType =
    enabled && taskCapability != null && !frameMode(mode) && inputs.length > 0;
  const sendsExplicitTaskType =
    requestsExplicitTaskType && capabilityAllowsValue(taskCapability, mode);

  if (enabled) {
    const images = inputs.filter((input) => input.kind === "image");
    const videos = inputs.filter((input) => input.kind === "video");
    for (const input of inputs) mediaRoles[input.key] = `reference_${input.kind}`;
    if (frameMode(mode)) {
      const first =
        images.find((input) => config.mediaRoles?.[input.key] === "first_frame") ?? images[0];
      const last =
        images.find(
          (input) => input.key !== first?.key && config.mediaRoles?.[input.key] === "last_frame",
        ) ?? images.find((input) => input.key !== first?.key);
      if (first) mediaRoles[first.key] = "first_frame";
      if (mode === "first_last_frame" && last) mediaRoles[last.key] = "last_frame";
      const required = mode === "first_frame" ? 1 : 2;
      if (inputs.length !== required || images.length !== required) {
        issue =
          mode === "first_frame"
            ? "首帧生视频需要且只能连接 1 张图片；请断开其他参考素材。"
            : "首尾帧生视频需要且只能连接 2 张图片；请断开其他参考素材。";
      }
      hint = "画幅自动跟随首帧；首帧/尾帧与参考图、视频、音频不可混用。";
    } else if (mode === "edit" || mode === "extend") {
      if (videos.length === 0)
        issue = `请连接至少 1 个待${mode === "edit" ? "编辑" : "延长"}的视频。`;
      hint =
        mode === "edit"
          ? "画幅与时长跟随原视频。每个参考视频须为 4–30 秒，最多 10 个且合计不超过 30 秒；提示词请明确增加、删除、修改或替换内容。"
          : "画幅跟随原视频；时长表示延长的部分，可选智能或模型已开放的 4–30 秒。每个参考视频须为 2–30 秒，最多 10 个且合计不超过 30 秒；提示词请明确向前/向后延长、延续或续写。";
      if (videos.length > 10) issue = "视频编辑和视频延长最多支持 10 个参考视频。";
    } else if (mode === "reference") {
      if (inputs.length === 0) issue = "参考生视频需要至少连接 1 个图片、视频或音频素材。";
      hint = "全部素材作为参考，画幅与时长可自由设置。";
    } else {
      hint = "按提示词自动判断任务。建议画幅选自适应、时长选智能，并使用 4–30 秒的参考视频。";
    }
    if (frameMode(mode) || mode === "edit" || mode === "extend") {
      parameterValues["ratio"] = "adaptive";
      lockedParameters.push("ratio");
    }
    if (mode === "edit") {
      parameterValues["duration"] = -1;
      lockedParameters.push("duration");
    }
    for (const key of lockedParameters) {
      const capability = capabilities.find((item) => item.key === key);
      if (!capability || !capabilityAllowsValue(capability, parameterValues[key]!)) {
        issue = `当前模型字段未开放${key === "ratio" ? "自适应画幅" : "智能时长"}，无法执行所选任务。`;
      }
    }
    if (frameMode(mode) || mode === "edit" || mode === "extend") {
      const duration = parameterCapabilities.find((item) => item.key === "duration");
      if (!duration || duration.options.length === 0) {
        issue =
          mode === "edit"
            ? "当前模型字段未开放智能时长，无法执行视频编辑。"
            : "当前模型未开放智能（-1）或 4–30 秒范围内的可用时长，无法执行所选任务。";
        delete parameterValues["duration"];
        if (!lockedParameters.includes("duration")) lockedParameters.push("duration");
      } else if (!duration.options.some((option) => option.value === parameterValues["duration"])) {
        parameterValues["duration"] = duration.defaultValue;
      }
    }
    delete parameterValues["omni_reference_task_type"];
    if (sendsExplicitTaskType) parameterValues["omni_reference_task_type"] = mode;
    else if (requestsExplicitTaskType)
      issue = "当前模型的任务字段未开放所选任务类型，请更换模型或选择已支持的任务。";
  }

  const parameters = generationParameters(
    parameterCapabilities,
    parameterValues,
    inputs.length > 0,
  );
  if (
    (frameMode(mode) || mode === "edit" || mode === "extend") &&
    parameterValues["duration"] == null
  )
    delete parameters["duration"];
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
    parameterCapabilities,
  };
}

/** Explicit user task changes also apply the tutorial's safe defaults for automatic mode. */
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
      mode === "auto"
        ? { ...config.parameterValues, ratio: "adaptive", duration: -1 }
        : config.parameterValues,
  };
  const state = resolveSeedanceTask(modelId, capabilities, next, inputs);
  return { ...next, parameterValues: state.parameterValues, mediaRoles: state.mediaRoles };
}
