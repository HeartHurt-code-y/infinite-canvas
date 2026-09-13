import { useId, useState } from "react";
import type { PromptContentConnection } from "../../lib/promptContent";
import { sameMediaReferenceTarget } from "../../lib/promptReferenceTarget";
import type { SeedanceTaskMode } from "../../lib/seedanceTasks";
import {
  createWhiteModelControlConfig,
  resolveWhiteModelControl,
  WHITE_MODEL_CONTROL_DIMENSIONS,
  type WhiteModelBinding,
  type WhiteModelControlConfig,
  type WhiteModelMapping,
} from "../../lib/whiteModelControl";
import "./WhiteModelControlSection.css";

function bindingMatches(binding: WhiteModelBinding, input: PromptContentConnection): boolean {
  return (
    binding.key === input.key &&
    binding.target.kind !== "url" &&
    sameMediaReferenceTarget(binding.target, input.target)
  );
}

function choiceValue(input: PromptContentConnection): string {
  return JSON.stringify([input.key, input.target]);
}

function WhiteModelBindingSelect({
  label,
  placeholder,
  binding,
  inputs,
  kind,
  onChange,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly binding: WhiteModelBinding | null;
  readonly inputs: readonly PromptContentConnection[];
  readonly kind: "image" | "video";
  readonly onChange: (binding: WhiteModelBinding | null) => void;
}) {
  const available = inputs.filter((input) => input.kind === kind && input.target.kind !== "url");
  const selected =
    binding == null ? null : available.find((input) => bindingMatches(binding, input));
  const missing = binding != null && selected == null;
  const typedInputs = inputs.filter((input) => input.kind === kind);
  return (
    <label className="white-model-control__field">
      <span>{label}</span>
      <select
        value={missing ? "unavailable" : selected ? choiceValue(selected) : ""}
        aria-invalid={missing || undefined}
        onChange={(event) => {
          if (event.target.value === "") {
            onChange(null);
            return;
          }
          const input = available.find(
            (candidate) => choiceValue(candidate) === event.target.value,
          );
          if (input) onChange({ key: input.key, name: input.name, target: input.target });
        }}
      >
        <option value="">{placeholder}</option>
        {missing ? (
          <option value="unavailable" disabled>
            {binding.name}（已断开/来源已变化）
          </option>
        ) : null}
        {available.map((input) => (
          <option key={input.key} value={choiceValue(input)}>
            {kind === "video" ? "视频" : "图片"} {typedInputs.indexOf(input) + 1} · {input.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function WhiteModelControlSection({
  config,
  inputs,
  modelId,
  taskMode,
  onChange,
  onOpenStudio,
}: {
  readonly config?: WhiteModelControlConfig | undefined;
  readonly inputs: readonly PromptContentConnection[];
  readonly modelId: string;
  readonly taskMode: SeedanceTaskMode;
  readonly onChange: (config: WhiteModelControlConfig) => void;
  readonly onOpenStudio?: (() => void) | undefined;
}) {
  const current = config ?? createWhiteModelControlConfig();
  const [expanded, setExpanded] = useState(current.enabled);
  const guidanceId = useId();
  const resolved = resolveWhiteModelControl(current, inputs, modelId, taskMode);
  const update = (patch: Partial<WhiteModelControlConfig>) => onChange({ ...current, ...patch });
  const updateMapping = (id: string, patch: Partial<WhiteModelMapping>) =>
    update({
      mappings: current.mappings.map((mapping) =>
        mapping.id === id ? { ...mapping, ...patch } : mapping,
      ),
    });

  return (
    <details
      className="white-model-control nodrag nowheel"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="white-model-control__summary">
        <strong>专业级白模控制</strong>
        <span className="white-model-control__state">
          {current.enabled ? (resolved.issue ? "待完善" : "已启用") : "未启用"}
        </span>
      </summary>
      <div className="white-model-control__body">
        {onOpenStudio ? (
          <button type="button" className="white-model-control__button" onClick={onOpenStudio}>
            制作白模动画 · Blender
          </button>
        ) : null}
        <label className="white-model-control__check">
          <input
            type="checkbox"
            checked={current.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          <span>启用白模控制</span>
        </label>
        <p className="white-model-control__hint" id={guidanceId}>
          在 Blender 工作台制作并接入白模动画；也可导入 Maya / Blender 导出的视频，选择为白模来源。
        </p>
        <p className="white-model-control__hint">
          启用后，以下预览与上方提示词一起提交；关闭后保留配置。
        </p>
        <p className="white-model-control__hint">
          此处用参考图选择器绑定素材；需要自由插入 @ 引用时，请使用上方提示词输入框。
        </p>
        {current.enabled ? (
          <>
            {resolved.issue ? (
              <p className="white-model-control__issue" role="alert">
                {resolved.issue}
              </p>
            ) : null}
            <WhiteModelBindingSelect
              label="白模参考视频"
              placeholder="请选择白模视频"
              binding={current.source}
              inputs={inputs}
              kind="video"
              onChange={(source) => update({ source })}
            />
            <label className="white-model-control__field">
              <span>白模颗粒度</span>
              <select
                value={current.granularity}
                aria-describedby={guidanceId}
                onChange={(event) => {
                  const granularity = event.target.value;
                  if (granularity === "coarse" || granularity === "fine") update({ granularity });
                }}
              >
                <option value="coarse">粗颗粒度 · 动态骨架</option>
                <option value="fine">细颗粒度 · 成片渲染</option>
              </select>
            </label>
            <p className="white-model-control__hint">
              {current.granularity === "coarse"
                ? "适合用简单几何体安排运镜与走位。文档建议优先使用粗颗粒度；若模型带四肢或翅膀，请在剧情中写出完整动作序列。"
                : "适合已完成建模的视频，补充材质、光影与风格。导出前请去除轨迹线、坐标线、相机锥体等辅助信息。"}
            </p>
            <fieldset className="white-model-control__dimensions">
              <legend>重点参考维度</legend>
              {WHITE_MODEL_CONTROL_DIMENSIONS.map((dimension) => (
                <label key={dimension.value} className="white-model-control__check">
                  <input
                    type="checkbox"
                    checked={current.controls.includes(dimension.value)}
                    onChange={(event) =>
                      update({
                        controls: event.target.checked
                          ? [...current.controls, dimension.value]
                          : current.controls.filter((control) => control !== dimension.value),
                      })
                    }
                  />
                  <span>{dimension.label}</span>
                </label>
              ))}
            </fieldset>
            <div className="white-model-control__mappings" aria-label="白模对应关系">
              <div className="white-model-control__section-heading">
                {current.granularity === "coarse" ? "模型与角色 / 道具对应" : "模型渲染要求"}
              </div>
              <p className="white-model-control__hint">
                用颜色或形状指明模型，再选择角色 / 道具参考图，或填写文字设定。
              </p>
              {current.mappings.map((mapping, index) => (
                <fieldset className="white-model-control__mapping" key={mapping.id}>
                  <legend>对应关系 {index + 1}</legend>
                  <label className="white-model-control__field">
                    <span>模型特征 {index + 1}</span>
                    <input
                      type="text"
                      value={mapping.modelPart}
                      placeholder="例如：红色圆柱体"
                      onChange={(event) =>
                        updateMapping(mapping.id, { modelPart: event.target.value })
                      }
                    />
                  </label>
                  <WhiteModelBindingSelect
                    label={`角色 / 道具参考图 ${index + 1}`}
                    placeholder="仅使用文字设定"
                    binding={mapping.reference}
                    inputs={inputs}
                    kind="image"
                    onChange={(reference) => updateMapping(mapping.id, { reference })}
                  />
                  <label className="white-model-control__field">
                    <span>角色 / 道具设定 {index + 1}</span>
                    <textarea
                      rows={2}
                      value={mapping.description}
                      placeholder="例如：穿银色装甲的机甲战士"
                      onChange={(event) =>
                        updateMapping(mapping.id, { description: event.target.value })
                      }
                    />
                  </label>
                  <button
                    className="white-model-control__button"
                    type="button"
                    onClick={() =>
                      update({
                        mappings: current.mappings.filter((entry) => entry.id !== mapping.id),
                      })
                    }
                  >
                    移除对应关系 {index + 1}
                  </button>
                </fieldset>
              ))}
              <button
                className="white-model-control__button"
                type="button"
                onClick={() =>
                  update({
                    mappings: [
                      ...current.mappings,
                      { id: crypto.randomUUID(), modelPart: "", description: "", reference: null },
                    ],
                  })
                }
              >
                添加对应关系
              </button>
            </div>
            <label className="white-model-control__field">
              <span>{current.granularity === "coarse" ? "时间线与剧情" : "分段渲染描述"}</span>
              <textarea
                rows={4}
                value={current.timeline}
                placeholder={
                  current.granularity === "coarse"
                    ? "0–3 秒：角色从前景走向门口，镜头缓慢跟随；3–6 秒：角色转身，描述动作、表情和台词。"
                    : "0–3 秒：金属材质、冷色环境、侧光；3 秒转场进入暖色室内，描述新场景的渲染要求。"
                }
                onChange={(event) => update({ timeline: event.target.value })}
              />
            </label>
            <WhiteModelBindingSelect
              label="场景参考图"
              placeholder="仅使用场景描述"
              binding={current.sceneReference}
              inputs={inputs}
              kind="image"
              onChange={(sceneReference) => update({ sceneReference })}
            />
            <label className="white-model-control__field">
              <span>场景处理</span>
              <textarea
                rows={2}
                value={current.scene}
                placeholder="描述背景环境，以及参考图中要使用的场景元素。"
                onChange={(event) => update({ scene: event.target.value })}
              />
            </label>
            <label className="white-model-control__field">
              <span>材质、风格与整体收束</span>
              <textarea
                rows={3}
                value={current.finish}
                placeholder="补充材质、光影、画质、一致性与音频要求，例如跨场景保持角色材质一致，保留环境声。"
                onChange={(event) => update({ finish: event.target.value })}
              />
            </label>
            <details className="white-model-control__preview">
              <summary>查看将提交的白模提示词</summary>
              <p className="white-model-control__hint">以下内容会与节点提示词一起提交。</p>
              <textarea
                className="white-model-control__preview-text"
                aria-label="白模提示词预览"
                readOnly
                rows={8}
                value={resolved.preview}
              />
            </details>
          </>
        ) : null}
      </div>
    </details>
  );
}
