import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CanvasSelect } from "../../components/CanvasSelect";
import {
  CANVAS_VIDEO_MODES,
  compileCanvasVideoMode,
  videoModeLabel,
  type CanvasVideoMode,
} from "../../lib/canvasVideoMode";
import {
  resolvedParameterValue,
  type ModelParameterCapability,
  type ModelParameterValue,
} from "../../lib/modelCapabilities";
import { providerSupportsAssetLibrary } from "../../lib/assetLibrarySupport";
import type { ProviderCatalogEntry } from "../../lib/backend";
import {
  resolveLongVideoSettings,
  resolveLongVideoSegmentSeconds,
  longVideoShotCount,
} from "../../lib/longVideo";
import type { VideoNodeConfig } from "./workspaceModel";
import { CanvasChromeIcon } from "./CanvasChromeIcons";
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
]);

function Parameter({
  capability,
  value,
  onChange,
}: {
  readonly capability: ModelParameterCapability;
  readonly value: ModelParameterValue;
  readonly onChange: (value: ModelParameterValue) => void;
}) {
  const label = /ratio/.test(capability.key)
    ? "比例"
    : capability.key === "resolution"
      ? "清晰度"
      : /duration|seconds/.test(capability.key)
        ? "视频时长"
        : capability.label;
  const duration = /duration|seconds/.test(capability.key);
  const numericChoices = capability.options
    .map((option) => Number(option.value))
    .filter((item) => Number.isFinite(item) && item > 0);
  const sliderMin = capability.minimum ?? (numericChoices.length ? Math.min(...numericChoices) : 1);
  const sliderMax =
    capability.maximum ?? (numericChoices.length ? Math.max(...numericChoices) : 300);
  return (
    <div className="canvas-video-parameter">
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
        <div className="canvas-video-options" role="group" aria-label={label}>
          {capability.options.map((option) => (
            <button
              type="button"
              key={String(option.value)}
              aria-pressed={value === option.value}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
          {!capability.options.some((option) => option.value === value) && value !== "" ? (
            <button type="button" aria-pressed="true" title="保留的自定义参数">
              {String(value)}
            </button>
          ) : null}
        </div>
      ) : capability.type === "integer" || capability.type === "number" ? (
        <label className="canvas-video-number">
          {duration ? (
            <input
              aria-label={`${label}快捷调整`}
              type="range"
              min={sliderMin}
              max={Math.max(sliderMin, sliderMax)}
              step={capability.step ?? 1}
              value={Math.max(sliderMin, Math.min(sliderMax, Number(value) || sliderMin))}
              onChange={(event) => onChange(Number(event.target.value))}
            />
          ) : null}
          <input
            aria-label={label}
            type="number"
            inputMode="decimal"
            value={value === "" ? "" : Number(value)}
            step={capability.step ?? (capability.type === "integer" ? 1 : "any")}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === "") onChange("");
              else if (Number.isFinite(Number(raw))) onChange(Number(raw));
            }}
          />
          {/duration|seconds/.test(capability.key) ? <span>s</span> : null}
        </label>
      ) : (
        <input
          aria-label={label}
          value={String(value)}
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
  capabilities,
  parameters,
  advanced,
  inputs,
  active,
  advancedHostId,
  providerCatalog,
}: {
  readonly config: VideoNodeConfig;
  readonly onChange: (config: VideoNodeConfig) => void;
  readonly modelLabel: string;
  readonly model: ReactNode;
  readonly capabilities: readonly ModelParameterCapability[];
  readonly parameters: ReactNode;
  readonly advanced: ReactNode;
  readonly inputs: readonly { key: string; kind: string }[];
  readonly active: boolean;
  readonly advancedHostId?: string | undefined;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  // 说明文字与控件的关联：同一画面可能有多个视频节点，id 必须唯一（useId）。
  const planHintId = useId();
  const continuityHintId = useId();
  useLayoutEffect(() => {
    setHost(advancedHostId ? document.getElementById(advancedHostId) : null);
  }, [advancedHostId]);
  const setParameter = (key: string, value: ModelParameterValue) =>
    onChange({ ...config, parameterValues: { ...config.parameterValues, [key]: value } });
  const mode = config.videoMode ?? config.seedanceTaskMode ?? "auto";
  const modeLabel = videoModeLabel(mode, inputs);
  const isLong = mode === "longVideo2video";
  const longSettings = resolveLongVideoSettings(config.longVideo, providerCatalog);
  // 单片段时长必须落在模型声明的档位上：后端会再夹一次，前端先夹是为了让用户看见真实可选值。
  const durationCapability = capabilities.find((capability) =>
    /^(duration|duration_seconds|seconds)$/.test(capability.key),
  );
  const durationChoices = (durationCapability?.options ?? [])
    .map((option) => Number(option.value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const segmentSeconds = resolveLongVideoSegmentSeconds(
    durationCapability,
    longSettings.segmentSeconds,
  );
  const shotCount = longVideoShotCount(longSettings.targetSeconds, segmentSeconds);
  const setLong = (values: Partial<typeof longSettings>) =>
    onChange({ ...config, longVideo: { ...longSettings, segmentSeconds, ...values } });
  // 数字输入框清空时 Number("") 是 0：直接写回会存下 0（后端拒绝 0 额度、0 时长），
  // 这里清空或非法时保留原值。
  //
  // 注意：目标总时长的下限是 30，**不能**在每次按键时按下限夹取——
  // 用户想打 250，先打「2」就会被夹成 30，后面再打的数字全是错的。
  // 目标时长的范围由 min/max 属性与后端校验兜底，其余字段的下限是 1，夹取无副作用。
  //
  // 取整是必须的：后端这三个字段是 u32，填 250.5 会在反序列化阶段就失败，
  // 用户看到的是一句看不懂的 "invalid type: floating point"，而不是人话校验。
  const numberOr = (raw: string, fallback: number) => {
    if (raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.round(value) : fallback;
  };
  const planners = providerCatalog
    .filter((entry) => entry.provider.enabled)
    .flatMap((entry) =>
      entry.models
        .filter((model) => model.operations.includes("text_generation"))
        .map((model) => ({
          value: `${entry.provider.id}:${model.definitionId}`,
          label: `${entry.provider.displayName} · ${model.displayName}`,
          providerId: entry.provider.id,
          modelId: model.definitionId,
        })),
    );
  const primary = capabilities.filter((capability) => PRIMARY_KEYS.has(capability.key));
  const parameterLabel = [
    ...(isLong ? [`目标 ${longSettings.targetSeconds}s`, `片段 ${segmentSeconds}s`] : []),
    ...primary
      .filter(
        (capability) =>
          capability.key !== "generate_audio" &&
          (!isLong || !/duration|seconds/.test(capability.key)),
      )
      .map((capability) => {
        const value = resolvedParameterValue(capability, config.parameterValues);
        const label =
          capability.options.find((option) => option.value === value)?.label ?? String(value);
        return /duration|seconds/.test(capability.key)
          ? `${value === -1 ? "自动" : value}${value === -1 ? "" : "s"}`
          : label;
      }),
    ...(isLong ? [] : [`${config.generationCount}个`]),
  ].join(" · ");
  const parameterFields = (
    <>
      {isLong ? (
        <div className="long-video-settings">
          <label>
            目标总时长（秒）
            <input
              type="number"
              min={30}
              max={300}
              step={1}
              value={longSettings.targetSeconds}
              onChange={(event) =>
                setLong({ targetSeconds: numberOr(event.target.value, longSettings.targetSeconds) })
              }
            />
          </label>
          <label>
            每个片段请求时长（秒）
            {durationChoices.length ? (
              <CanvasSelect
                ariaLabel="每个片段请求时长（秒）"
                value={String(segmentSeconds)}
                options={durationChoices.map((value) => ({
                  value: String(value),
                  label: `${value}s`,
                }))}
                onChange={(value) => setLong({ segmentSeconds: Number(value) })}
              />
            ) : (
              <input
                type="number"
                min={1}
                max={300}
                step={1}
                value={segmentSeconds}
                onChange={(event) =>
                  setLong({
                    segmentSeconds: Math.min(
                      300,
                      Math.max(1, numberOr(event.target.value, segmentSeconds)),
                    ),
                  })
                }
              />
            )}
          </label>
          <label>
            同时在途片段数
            <input
              type="number"
              min={1}
              max={8}
              step={1}
              value={longSettings.maxConcurrentSegments}
              onChange={(event) =>
                setLong({
                  maxConcurrentSegments: Math.min(
                    8,
                    Math.max(1, numberOr(event.target.value, longSettings.maxConcurrentSegments)),
                  ),
                })
              }
              readOnly={longSettings.linkPreviousFrame}
              aria-disabled={longSettings.linkPreviousFrame}
              aria-describedby={continuityHintId}
            />
          </label>
          <label>
            最多新建片段任务
            <input
              type="number"
              min={1}
              step={1}
              value={longSettings.submissionBudget}
              onChange={(event) =>
                setLong({
                  submissionBudget: Math.max(
                    1,
                    numberOr(event.target.value, longSettings.submissionBudget),
                  ),
                })
              }
              aria-describedby={planHintId}
            />
          </label>
          <label>
            镜头规划模型
            <CanvasSelect
              ariaLabel="镜头规划模型"
              value={`${longSettings.plannerProviderId}:${longSettings.plannerModelId}`}
              options={planners.length ? planners : [{ value: ":", label: "请先配置文本模型" }]}
              onChange={(value) => {
                const chosen = planners.find((item) => item.value === value);
                if (chosen)
                  setLong({ plannerProviderId: chosen.providerId, plannerModelId: chosen.modelId });
              }}
            />
          </label>
          <label className="canvas-video-switch">
            <span>确认镜头后生成</span>
            <input
              type="checkbox"
              checked={longSettings.approveScript}
              onChange={(event) => setLong({ approveScript: event.target.checked })}
            />
            <i aria-hidden="true" />
          </label>
          <label className="canvas-video-switch">
            <span>使用上一镜头尾帧承接</span>
            <input
              type="checkbox"
              checked={longSettings.linkPreviousFrame}
              onChange={(event) => setLong({ linkPreviousFrame: event.target.checked })}
            />
            <i aria-hidden="true" />
          </label>
          <small id={planHintId}>
            先调用文本模型规划 {shotCount}{" "}
            个镜头，再按窗口并发生成片段并合成。额度按新建片段任务次数计算，实际费用由供应商结算；
            {shotCount} 个镜头至少需要 {shotCount} 次额度（重试另计）。
          </small>
          <small id={continuityHintId}>
            尾帧承接依赖上一镜头先出片，片段会串行执行（同时在途固定 1 个），5
            分钟视频可能需要数小时；关闭后按全片连续性约束并发生成。
          </small>
        </div>
      ) : null}
      {primary
        .filter((capability) => !isLong || !/duration|seconds/.test(capability.key))
        .map((capability) => (
          <Parameter
            key={capability.key}
            capability={capability}
            value={resolvedParameterValue(capability, config.parameterValues)}
            onChange={(value) => setParameter(capability.key, value)}
          />
        ))}
      {!isLong ? (
        <div className="canvas-video-parameter">
          <span>生成数量</span>
          <div className="canvas-video-options" role="group" aria-label="生成数量">
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
      {capabilities.some(
        (capability) =>
          !PRIMARY_KEYS.has(capability.key) &&
          capability.key !== "web_search" &&
          capability.key !== "omni_reference_task_type",
      ) ? (
        <details className="canvas-video-extra">
          <summary>更多参数</summary>
          {parameters}
        </details>
      ) : null}
    </>
  );
  const libraries = providerCatalog
    .map((entry) => entry.provider)
    .filter((provider) => provider.enabled && providerSupportsAssetLibrary(provider));
  const verificationProviderId =
    config.verificationProviderId ??
    libraries.find((provider) => provider.id === config.modelSelection.providerId)?.id ??
    libraries[0]?.id ??
    "";
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
      <label className="canvas-video-switch">
        <span>联网搜索</span>
        <input
          type="checkbox"
          role="switch"
          checked={searchEnabled === true}
          onChange={(event) => setParameter("web_search", event.target.checked)}
        />
        <i aria-hidden="true" />
      </label>
      <label
        className="canvas-video-switch"
        data-tooltip="通过素材库自动入库并等待服务端合规审核；关闭可跳过这一步。"
      >
        <span>
          自动校验素材 <CanvasChromeIcon name="help" size={12} />
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
          智能引用 AutoLink <CanvasChromeIcon name="help" size={12} />
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={config.autoLink !== false}
          onChange={(event) => onChange({ ...config, autoLink: event.target.checked })}
        />
        <i aria-hidden="true" />
      </label>
      {config.autoVerifyMaterials !== false ? (
        <div className="canvas-video-verification-provider">
          <span>校验素材库</span>
          <CanvasSelect
            ariaLabel="校验素材库"
            value={verificationProviderId}
            options={[
              ...(verificationProviderId &&
              !libraries.some((provider) => provider.id === verificationProviderId)
                ? [{ value: verificationProviderId, label: "原素材库连接（不可用）" }]
                : []),
              ...(libraries.length
                ? libraries.map((provider) => ({ value: provider.id, label: provider.displayName }))
                : [{ value: "", label: "请先配置云端素材库连接" }]),
            ]}
            onChange={(verificationProviderId) => onChange({ ...config, verificationProviderId })}
          />
          <small>本地参考自动入库；审核通过后提交生成。已入库素材复用原身份。</small>
        </div>
      ) : null}
      <details className="canvas-video-extra">
        <summary>更多模型设置</summary>
        <div className="canvas-gen-node__settings">{advanced}</div>
      </details>
    </section>
  );
  return (
    <>
      <VideoNodeSettingsControls
        active={active}
        modelLabel={modelLabel}
        parameterLabel={parameterLabel || "视频参数"}
        modeLabel={modeLabel}
        model={model}
        parameters={parameterFields}
        advanced={null}
        inlineAdvanced
        modeControl={
          <CanvasSelect
            className="canvas-video-mode"
            ariaLabel="视频生成模式"
            value={mode}
            options={CANVAS_VIDEO_MODES}
            onChange={(value) => {
              const videoMode = value as CanvasVideoMode;
              const intent = compileCanvasVideoMode(videoMode, inputs, config.mediaRoles);
              onChange({
                ...config,
                videoMode,
                seedanceTaskMode: intent.taskMode,
                mediaRoles: intent.mediaRoles,
              });
            }}
          />
        }
      />
      <button
        type="button"
        className="canvas-video-advanced-trigger"
        aria-label="高级设置"
        aria-expanded={config.advancedOpen === true}
        title="高级设置"
        onClick={() => onChange({ ...config, advancedOpen: !config.advancedOpen })}
      >
        <CanvasChromeIcon name="adjust" size={16} />
      </button>
      {host ? createPortal(switches, host) : switches}
    </>
  );
}
