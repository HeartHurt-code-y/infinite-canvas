import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal } from "lucide-react";
import { CanvasSelect } from "../../components/CanvasSelect";
import {
  canvasVideoModeOptions,
  canvasVideoModeValue,
  compileCanvasVideoMode,
  type CanvasVideoMode,
} from "../../lib/canvasVideoMode";
import {
  resolvedParameterValue,
  isFzyVideoSchema,
  isSeedance25VideoModel,
  isSeedance20VideoModel,
  type ModelParameterCapability,
  type ModelParameterValue,
} from "../../lib/modelCapabilities";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { isMoyuKlingV4Model } from "../../lib/klingV4";
import { resolveSeedanceTask, seedanceTaskInputs, selectSeedanceTask } from "../../lib/seedanceTasks";
import { PIXVERSE_PROFILE, PIXVERSE_ACTIONS, pixverseIntent, pixverseFieldVisible, pixverseHint } from "../../lib/pixverse";
import {
  resolveLongVideoSettings,
} from "../../lib/longVideo";
import type { VideoNodeConfig } from "./workspaceModel";
import { LibTVMediaIcon, videoModeIcon } from "./LibTVMediaIcon";
import { VideoNodeSettingsControls } from "./VideoNodeSettingsControls";
import "./CanvasVideoEditor.css";

const PRIMARY_KEYS = new Set([
  "ratio",
  "aspect_ratio",
  "resolution",
  "quality",
  "duration",
  "duration_seconds",
  "seconds",
  "generate_audio",
  "audio",
  "generate_audio_switch",
]);

const LONG_VIDEO_DURATION: ModelParameterCapability = {
  key: "duration", label: "视频时长", type: "integer", defaultValue: 300,
  options: [], minimum: 30, maximum: 300, step: 1,
  optional: false, requiresNoMedia: false, order: 2,
};

function ratioDimensions(value: ModelParameterValue) {
  const [width, height] = String(value).split(":").map(Number);
  if (!width || !height) return { width: 16, height: 12 };
  const scale = Math.min(20 / width, 18 / height);
  return { width: width * scale, height: height * scale };
}

function optionLabel(capability: ModelParameterCapability, value: ModelParameterValue): string {
  const label = capability.options.find(option => option.value === value)?.label ?? String(value);
  if (/^(ratio|aspect_ratio)$/.test(capability.key) && /^(auto|adaptive)$/i.test(String(value))) return "Auto";
  return capability.key === "resolution" ? label.toUpperCase() : label;
}

function Parameter({
  capability,
  value,
  onChange,
}: {
  readonly capability: ModelParameterCapability;
  readonly value: ModelParameterValue;
  readonly onChange: (value: ModelParameterValue) => void;
}) {
  const isRatio = /^(ratio|aspect_ratio)$/.test(capability.key);
  const label = isRatio
    ? "比例"
    : capability.key === "resolution"
      ? "清晰度"
      : /^(generate_audio|audio|generate_audio_switch)$/.test(capability.key)
        ? "生成音频"
      : /duration|seconds/.test(capability.key)
        ? "视频时长"
        : capability.label;
  const duration = /duration|seconds/.test(capability.key);
  const numericChoices = capability.options
    .map((option) => Number(option.value))
    .filter((item) => Number.isFinite(item) && item > 0);
  const sliderMin = capability.minimum != null && capability.minimum > 0 ? capability.minimum : numericChoices.length ? Math.min(...numericChoices) : 1;
  const sliderMax = Math.max(sliderMin, capability.maximum != null && capability.maximum > 0 ? capability.maximum : numericChoices.length ? Math.max(...numericChoices) : 300);
  const automaticDuration = duration ? capability.options.find(option => Number(option.value) === -1) : undefined;
  const changeNumber = (next: number, snap = false) => {
    const clamped = Math.max(sliderMin, Math.min(sliderMax, snap && capability.type === "integer" ? Math.round(next) : next));
    const option = duration && snap && numericChoices.length
      ? capability.options.filter(item => Number(item.value) > 0).reduce((closest, item) =>
          Math.abs(Number(item.value) - clamped) < Math.abs(Number(closest.value) - clamped) ? item : closest)
      : null;
    onChange(option?.value ?? (capability.type === "string" ? String(snap ? clamped : next) : snap ? clamped : next));
  };
  if (duration && (capability.type === "integer" || capability.type === "number" || numericChoices.length > 0)) {
    return <div className="canvas-video-parameter" data-parameter-key={capability.key} data-tooltip={capability.description}>
      <div className="canvas-video-duration-heading">
        <span>{label}</span>
        <label className="canvas-video-duration-value">
          <input aria-label={label} type="number" inputMode="decimal" min={sliderMin} max={sliderMax}
            value={value === "" || Number(value) === -1 ? "" : Number(value)}
            placeholder={automaticDuration ? "自动" : undefined}
            step={capability.step ?? (capability.type === "integer" ? 1 : "any")}
            onChange={event => { if (event.target.value === "") onChange(""); else if (Number.isFinite(Number(event.target.value))) changeNumber(Number(event.target.value)); }}
            onBlur={event => { if (event.target.value !== "") changeNumber(Number(event.target.value), true); }} />
          <span>s</span>
        </label>
        {automaticDuration ? <button type="button" aria-pressed={Number(value) === -1} onClick={() => onChange(automaticDuration.value)}>自动</button> : null}
      </div>
      <input className="canvas-video-duration-slider" aria-label={`${label}快捷调整`} type="range"
        min={sliderMin} max={sliderMax} step={capability.step ?? 1}
        value={Math.max(sliderMin, Math.min(sliderMax, Number(value) || sliderMin))}
        onChange={event => changeNumber(Number(event.target.value), true)} />
    </div>;
  }
  const displayOptions = [...capability.options].sort((left, right) => {
    if (isRatio) {
      const order = ["auto", "adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
      const rank = (value: ModelParameterValue) => { const index = order.indexOf(String(value).toLowerCase()); return index < 0 ? order.length : index; };
      return rank(left.value) - rank(right.value);
    }
    if (capability.key === "resolution") {
      const rank = (value: ModelParameterValue) => /k$/i.test(String(value)) ? Number.parseFloat(String(value)) * 1024 : Number.parseFloat(String(value));
      return rank(left.value) - rank(right.value);
    }
    return 0;
  });
  return (
    <div className="canvas-video-parameter" data-parameter-key={capability.key} data-tooltip={capability.description}>
      <span>{label}</span>
      {capability.type === "boolean" ? (
        <div className="canvas-video-options" role="group" aria-label={label}>
          {[true, false].map((item) => (
            <button
              key={String(item)}
              type="button"
              aria-pressed={value === item}
              onClick={() => onChange(item)}
            >
              {item ? "开启" : "关闭"}
            </button>
          ))}
        </div>
      ) : capability.options.length > 0 && !/duration|seconds/.test(capability.key) ? (
        <div className={`canvas-video-options${isRatio ? " canvas-video-options--ratio" : ""}`} role="group" aria-label={label}>
          {displayOptions.map((option) => (
            <button
              type="button"
              key={String(option.value)}
              aria-pressed={value === option.value}
              onClick={() => onChange(option.value)}
            >
              {isRatio ? <i className="canvas-video-ratio-shape" style={ratioDimensions(option.value)} aria-hidden="true" /> : null}
              <span>{optionLabel(capability, option.value)}</span>
            </button>
          ))}
          {!capability.options.some((option) => option.value === value) && value !== "" ? (
            <button type="button" aria-pressed="true" title="保留的自定义参数">
              {String(value)}
            </button>
          ) : null}
        </div>
      ) : capability.type === "integer" || capability.type === "number" || (duration && numericChoices.length > 0) ? (
        <label className="canvas-video-number">
          {duration ? (
            <input
              aria-label={`${label}快捷调整`}
              type="range"
              min={sliderMin}
              max={Math.max(sliderMin, sliderMax)}
              step={capability.step ?? 1}
              value={Math.max(sliderMin, Math.min(sliderMax, Number(value) || sliderMin))}
              onChange={(event) => changeNumber(Number(event.target.value), true)}
            />
          ) : null}
          <input
            aria-label={label}
            type="number"
            inputMode="decimal"
            min={duration ? sliderMin : capability.minimum}
            max={duration ? sliderMax : capability.maximum}
            value={value === "" || (duration && Number(value) === -1) ? "" : Number(value)}
            placeholder={automaticDuration ? "自动" : undefined}
            step={capability.step ?? (capability.type === "integer" ? 1 : "any")}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === "") onChange("");
              else if (Number.isFinite(Number(raw))) changeNumber(Number(raw));
            }}
            onBlur={(event) => { if (duration && event.target.value !== "") changeNumber(Number(event.target.value), true); }}
          />
          {/duration|seconds/.test(capability.key) ? <span>s</span> : null}
          {automaticDuration ? <button type="button" aria-pressed={Number(value) === -1} onClick={() => onChange(automaticDuration.value)}>自动</button> : null}
        </label>
      ) : (
        <input
          aria-label={label}
          value={String(value)}
          placeholder={capability.optional ? /(?:media_id|video_id|restyle_id|speaker_id)$/.test(capability.key) ? "填写一个平台资源 ID" : "可选" : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

export function CanvasVideoSettings({
  config,
  onChange,
  modelLabel,
  model,
  referenceSettings,
  capabilities,
  inputs,
  active,
  advancedHostId,
  providerCatalog,
}: {
  readonly config: VideoNodeConfig;
  readonly onChange: (config: VideoNodeConfig) => void;
  readonly modelLabel: string;
  readonly model: ReactNode;
  readonly referenceSettings: ReactNode;
  readonly capabilities: readonly ModelParameterCapability[];
  readonly inputs: readonly { key: string; kind: string }[];
  readonly active: boolean;
  readonly advancedHostId?: string | undefined;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(advancedHostId ? document.getElementById(advancedHostId) : null);
  }, [advancedHostId]);
  const setParameter = (key: string, value: ModelParameterValue) => {
    const next: Record<string, ModelParameterValue> = {
      ...config.parameterValues,
      [key]: value,
      ...(key === "resolution" && String(value).toLowerCase() === "1080p" && config.parameterValues["draft"] === true
        ? { draft: false } : {}),
    };
    if (pixverse && value !== "") {
      if (key === "source_video_id") delete next["video_media_id"];
      if (key === "video_media_id") delete next["source_video_id"];
      if (key === "audio_media_id") { delete next["lip_sync_tts_content"]; delete next["lip_sync_tts_speaker_id"]; }
      if (key === "lip_sync_tts_content" || key === "lip_sync_tts_speaker_id") delete next["audio_media_id"];
    }
    onChange({ ...config, parameterValues: next });
  };
  const mode = config.videoMode ?? config.seedanceTaskMode ?? "auto";
  const modeInputs = [...inputs, ...(config.perTaskUrlMedia ?? [])];
  const selectedModel = providerCatalog.find(entry => entry.provider.id === config.modelSelection.providerId)
    ?.models.find(model => model.definitionId === config.modelSelection.modelDefinitionId);
  const klingV4 = isMoyuKlingV4Model(selectedModel?.remoteModelId ?? "");
  const pixverse = (selectedModel?.operationSchema["video_generation"] as Record<string, unknown> | undefined)?.["requestProfileId"] === PIXVERSE_PROFILE;
  const pixverseV6 = selectedModel?.remoteModelId.toLowerCase() === "pixverse-v6";
  const pixverseState = pixverseIntent(selectedModel?.remoteModelId ?? "", config.parameterValues, modeInputs, Object.values(config.mediaRoles ?? {}).includes("last_frame"));
  const pixverseActionValue = config.parameterValues["action"] ? pixverseState.omni ? "fusion_omni" : String(config.parameterValues["action"]) : "";
  const setPixverseAction = (value: string) => {
    const action = value === "fusion_omni" ? "fusion" : value;
    const values = { ...config.parameterValues };
    if (action) values["action"] = action; else delete values["action"];
    if (value === "fusion_omni") { values["reference_mode"] = "omni"; values["aspect_ratio"] = "auto"; }
    else { delete values["reference_mode"]; if (values["aspect_ratio"] === "auto") values["aspect_ratio"] = "16:9"; }
    const videoMode = action === "transition" ? "first_last_frame" : action === "img" ? "first_frame" : action === "text" ? "text" : "reference";
    const intent = compileCanvasVideoMode(videoMode, inputs, config.mediaRoles);
    const nextIntent = pixverseIntent(selectedModel?.remoteModelId ?? "", values, modeInputs, action === "transition");
    for (const key of Object.keys(values)) {
      if (key !== "action" && key !== "reference_mode" && !pixverseFieldVisible(key, nextIntent)) delete values[key];
    }
    onChange({ ...config, parameterValues: values, videoMode: value ? videoMode : "auto", seedanceTaskMode: value ? intent.taskMode : "auto", mediaRoles: intent.mediaRoles });
  };
  const supportsVideoTasks = !!selectedModel && !isFzyVideoSchema(selectedModel.operationSchema) && (isSeedance25VideoModel(selectedModel.remoteModelId) || isSeedance20VideoModel(selectedModel.remoteModelId));
  const taskInputs = seedanceTaskInputs(modeInputs.map((input, index) => ({ key: "key" in input ? input.key : `url-${index}`, kind: input.kind })));
  const seedanceIntent = compileCanvasVideoMode(mode as CanvasVideoMode, taskInputs, config.mediaRoles);
  const seedance = resolveSeedanceTask(selectedModel?.remoteModelId ?? "", capabilities,
    { ...config, seedanceTaskMode: seedanceIntent.taskMode, mediaRoles: seedanceIntent.mediaRoles },
    taskInputs, selectedModel?.operationSchema);
  const effectiveValues = seedance.enabled ? seedance.parameterValues : config.parameterValues;
  const followingRatio = seedance.mode === "first_frame" || seedance.mode === "first_last_frame" ? "跟随首帧画幅"
    : seedance.mode === "edit" || seedance.mode === "extend" ? "跟随原片画幅" : "自适应画幅";
  const modeOptions = canvasVideoModeOptions(mode, modeInputs, supportsVideoTasks, klingV4)
    .map(option => supportsVideoTasks && option.value === "reference" ? { ...option, label: "参考生视频" } : option);
  if (supportsVideoTasks) modeOptions.unshift({ value: "auto", label: "全参考 · 自动判断", disabled: taskInputs.length === 0 });
  const isLong = mode === "longVideo2video";
  const longSettings = resolveLongVideoSettings(config.longVideo, providerCatalog);
  // 调度参数保留在任务配置中；节点面板只编辑创作参数。
  const setLong = (values: Partial<typeof longSettings>) =>
    onChange({ ...config, longVideo: { ...longSettings, ...values } });
  const planners = providerCatalog
    .filter((entry) => entry.provider.enabled)
    .flatMap((entry) =>
      entry.models
        .filter((model) => model.operations.includes("text_generation"))
        .map((model) => ({
          value: JSON.stringify([entry.provider.id, model.definitionId]),
          label: `${entry.provider.displayName} · ${model.displayName}`,
          providerId: entry.provider.id,
          modelId: model.definitionId,
        })),
    );
  const parameterOrder = (key: string) => /^(ratio|aspect_ratio)$/.test(key) ? 0 : /resolution|quality/.test(key) ? 1 : /duration|seconds/.test(key) ? 2 : 3;
  const primary = capabilities.filter((capability) => PRIMARY_KEYS.has(capability.key) &&
    (!pixverse || pixverseFieldVisible(capability.key, pixverseState)) &&
    (!isLong || !/duration|seconds/.test(capability.key))).map(capability => pixverse && pixverseState.omni && capability.key === "aspect_ratio"
      ? { ...capability, options: [{ value: "auto", label: "自动跟随" }, ...capability.options] } : capability);
  if (isLong) primary.push(LONG_VIDEO_DURATION);
  primary.sort((left, right) => parameterOrder(left.key) - parameterOrder(right.key));
  const audioCapability = primary.find(capability => /^(generate_audio|audio|generate_audio_switch)$/.test(capability.key));
  const audioValue = audioCapability ? resolvedParameterValue(audioCapability, config.parameterValues) : null;
  const audioEnabled = audioValue === true || /^(1|true|on|enabled)$/i.test(String(audioValue));
  const parameterLabel = [
    ...primary
      .filter(
        (capability) =>
          !/^(generate_audio|audio|generate_audio_switch|multi_shot)$/.test(capability.key),
      )
      .map((capability) => {
        const value = isLong && capability === LONG_VIDEO_DURATION
          ? longSettings.targetSeconds
           : resolvedParameterValue(capability, effectiveValues);
         if (seedance.lockedParameters.includes(capability.key)) return capability.key === "ratio" ? followingRatio : seedance.mode === "edit" ? "原片时长" : "智能时长";
        const label = optionLabel(capability, value);
        return /duration|seconds/.test(capability.key)
          ? `${value === -1 ? "自动" : value}${value === -1 ? "" : "s"}`
          : label;
      }),
    ...(pixverse && pixverseState.durationFromVideo ? ["匹配参考时长"] : []),
    ...(isLong ? [] : [`${config.generationCount}个`]),
  ].join(" · ");
  const parameterFields = (
    <>
      {seedance.enabled && !isLong ? <small className="canvas-video-duration-note" role="note">{seedance.hint}</small> : null}
      {pixverse ? <small className="canvas-video-duration-note">{pixverseHint(pixverseState)}</small> : null}
      {pixverseState.durationFromVideo && pixverse ? <div className="canvas-video-parameter"><span>视频时长</span><span>匹配最长参考视频</span></div> : null}
      {primary.map((capability) => seedance.lockedParameters.includes(capability.key) && !isLong ? (
          <div key={capability.key} className="canvas-video-parameter" data-tooltip={seedance.hint}>
            <span>{capability.label}</span>
            <span>{capability.key === "ratio" ? followingRatio : seedance.mode === "edit" ? "跟随原视频" : "智能时长"}</span>
          </div>
        ) : (
          <Parameter
            key={capability.key}
            capability={capability}
            value={isLong && capability === LONG_VIDEO_DURATION ? longSettings.targetSeconds : resolvedParameterValue(capability, effectiveValues)}
            onChange={(value) => {
              if (isLong && capability === LONG_VIDEO_DURATION) {
                if (value !== "" && Number.isFinite(Number(value))) setLong({ targetSeconds: Math.round(Number(value)) });
              } else setParameter(capability.key, value);
            }}
          />
        ))}
      {isLong ? <small className="canvas-video-duration-note">因剧情和画面设计，实际时长可能略有差异。</small> : null}
      {isLong ? <div className="canvas-video-parameter">
        <span>镜头规划模型</span>
        <CanvasSelect
          ariaLabel="镜头规划模型"
          value={JSON.stringify([longSettings.plannerProviderId, longSettings.plannerModelId])}
          options={planners.length ? planners : [{ value: "", label: "请先配置文本模型" }]}
          onChange={(value) => {
            const chosen = planners.find((item) => item.value === value);
            if (chosen) setLong({ plannerProviderId: chosen.providerId, plannerModelId: chosen.modelId });
          }}
        />
      </div> : null}
      {!isLong ? (
        <div className="canvas-video-parameter">
          <span>生成数量</span>
          <div className="canvas-video-options canvas-video-options--count" role="group" aria-label="生成数量">
            {[1, 2, 4].map((count) => (
              <button
                key={count}
                type="button"
                aria-pressed={config.generationCount === count}
                onClick={() => onChange({ ...config, generationCount: count })}
              >
                {count}个
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {klingV4 ? <>
        {capabilities.filter(capability => capability.key === "element_ids" || capability.key === "voice_ids").map(capability => (
          <Parameter key={capability.key} capability={capability}
            value={resolvedParameterValue(capability, config.parameterValues)}
            onChange={value => setParameter(capability.key, value)} />
        ))}
        <small className="canvas-video-duration-note">主体和音色使用可灵已创建的 ID；所有图片、视频、主体和音色合计最多 15 项。</small>
        <small className="canvas-video-duration-note">镜头安排请写在提示词中；当前模型不支持关闭多镜头。</small>
      </> : null}
      {pixverse ? <>
        {capabilities.filter(capability => capability.key === "generate_multi_clip_switch" && pixverseState.multiClip).map(capability => <Parameter key={capability.key} capability={capability} value={resolvedParameterValue(capability, config.parameterValues)} onChange={value => setParameter(capability.key, value)} />)}
        <details className="canvas-video-extra-parameters"><summary>更多参数</summary>
          {capabilities.filter(capability => !PRIMARY_KEYS.has(capability.key) && capability.key !== "generate_multi_clip_switch" && pixverseFieldVisible(capability.key, pixverseState)).map(capability => <Parameter key={capability.key} capability={capability} value={resolvedParameterValue(capability, config.parameterValues)} onChange={value => setParameter(capability.key, value)} />)}
          {pixverseState.videoInput && pixverseState.videos === 0 ? <small className="canvas-video-duration-note">视频任务 ID 与上传资源 ID 二选一；连接本地视频时无需填写。</small> : null}
        </details>
      </> : null}
      {seedance.enabled && capabilities.some(capability => !PRIMARY_KEYS.has(capability.key) && !["omni_reference_task_type", "draft", "web_search"].includes(capability.key)) ?
        <details className="canvas-video-extra-parameters"><summary>更多参数</summary>
          {capabilities.filter(capability => !PRIMARY_KEYS.has(capability.key) && !["omni_reference_task_type", "draft", "web_search"].includes(capability.key)).map(capability => (
            <Parameter key={capability.key} capability={capability} value={resolvedParameterValue(capability, effectiveValues)} onChange={value => setParameter(capability.key, value)} />
          ))}
        </details> : null}
      {referenceSettings}
    </>
  );
  const searchCapability = capabilities.find((capability) => capability.key === "web_search");
  const searchEnabled =
    config.parameterValues["web_search"] ?? searchCapability?.defaultValue ?? false;
  const switches = (
    <section
      className="canvas-video-advanced"
      aria-label="高级设置"
      hidden={!active || !config.advancedOpen}
    >
      <strong>高级设置</strong>
      <label className="canvas-video-switch" data-tooltip={searchCapability ? searchCapability.description : "当前模型不支持联网搜索"}>
        <span>联网搜索</span>
        <input
          type="checkbox"
          role="switch"
          checked={searchEnabled === true}
          disabled={!searchCapability && searchEnabled !== true}
          onChange={(event) => setParameter("web_search", event.target.checked)}
        />
        <i aria-hidden="true" />
      </label>
      <label
        className="canvas-video-switch"
        data-tooltip="通过素材库自动入库并等待服务端合规审核；关闭可跳过这一步。"
      >
        <span>
          自动校验素材 <LibTVMediaIcon name="help" size={12} />
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={config.autoVerifyMaterials !== false}
          onChange={(event) => onChange({ ...config, autoVerifyMaterials: event.target.checked })}
        />
        <i aria-hidden="true" />
      </label>
      <label
        className="canvas-video-switch"
        data-tooltip="自动识别已连接素材的名称，并绑定成带素材身份的 @ 引用。"
      >
        <span>
          智能引用 AutoLink <LibTVMediaIcon name="help" size={12} />
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={config.autoLink !== false}
          onChange={(event) => onChange({ ...config, autoLink: event.target.checked })}
        />
        <i aria-hidden="true" />
      </label>
    </section>
  );
  return (
    <>
      <VideoNodeSettingsControls
        active={active}
        modelLabel={modelLabel}
        parameterLabel={parameterLabel || "视频参数"}
        parameterAccessory={audioCapability ? <span role="img" aria-label={audioEnabled ? "生成声音已开启" : "生成声音已关闭"}><LibTVMediaIcon name={audioEnabled ? "icon-volume-filled" : "icon-volume-off"} size={14} /></span> : null}
        model={model}
        parameters={parameterFields}
        modeControl={pixverse ?
          <CanvasSelect className="canvas-video-mode" ariaLabel="PixVerse 能力模式" value={pixverseActionValue}
            options={[{value: "", label: `自动 · ${PIXVERSE_ACTIONS.find(([value]) => value === pixverseState.action)?.[1] ?? pixverseState.action}${pixverseState.omni ? "（Omni）" : ""}`}, ...PIXVERSE_ACTIONS.map(([value,label])=>({value,label})), ...(pixverseV6 ? [{value:"fusion_omni",label:"全能参考（V6 Omni）"}] : [])]}
            onChange={setPixverseAction} /> :
          <CanvasSelect
            className="canvas-video-mode"
            ariaLabel="视频生成模式"
            value={supportsVideoTasks && mode === "auto" ? "auto" : canvasVideoModeValue(mode, modeInputs)}
            options={modeOptions.map(option => ({ ...option, icon: <LibTVMediaIcon name={videoModeIcon(option.value)} size={16} /> }))}
            chevronIcon={<LibTVMediaIcon name="icon-chevron-down-small" size={12} />}
            selectedIcon={<LibTVMediaIcon name="check" size={12} />}
            onChange={(value) => {
              const videoMode = value as CanvasVideoMode;
              const intent = compileCanvasVideoMode(videoMode, inputs, config.mediaRoles);
              if (klingV4 && videoMode === "edit") {
                const source = inputs.find(input => input.kind === "video" && config.mediaRoles?.[input.key] === "base_video")
                  ?? inputs.find(input => input.kind === "video");
                if (source) intent.mediaRoles[source.key] = "base_video";
              }
              onChange({
                ...(supportsVideoTasks && selectedModel ? selectSeedanceTask(selectedModel.remoteModelId, capabilities,
                  config, taskInputs, intent.taskMode, selectedModel.operationSchema) : config),
                videoMode,
                seedanceTaskMode: intent.taskMode,
                mediaRoles: intent.mediaRoles,
              });
            }}
          />
        }
      />
      <div id={advancedHostId?.replace("video-advanced-", "video-tools-")} className="canvas-video-prompt-actions" />
      <button
        type="button"
        className="canvas-video-advanced-trigger"
        aria-label="高级设置"
        aria-expanded={config.advancedOpen === true}
        data-tooltip="高级设置"
        aria-controls={advancedHostId}
        onClick={() => onChange({ ...config, advancedOpen: !config.advancedOpen })}
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
      </button>
      {host ? createPortal(switches, host) : switches}
    </>
  );
}
