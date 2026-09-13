import { useId, useState } from "react";
import {
  createGreenScreenConfig,
  resolveGreenScreen,
  type GreenScreenBinding,
  type GreenScreenConfig,
} from "../../lib/greenScreen";
import type { PromptContentConnection } from "../../lib/promptContent";
import { sameMediaReferenceTarget } from "../../lib/promptReferenceTarget";
import "./GreenScreenSection.css";

export interface GreenScreenResult {
  readonly key: string;
  readonly name: string;
  readonly src: string;
  readonly taskId: string;
  readonly finalPath: string;
}

export interface GreenScreenSectionProps {
  readonly config?: GreenScreenConfig | undefined;
  readonly inputs: readonly PromptContentConnection[];
  readonly modelId: string;
  readonly onChange: (config: GreenScreenConfig) => void;
  readonly onGenerate?: (() => void) | undefined;
  readonly busy?: boolean | undefined;
  readonly results?: readonly GreenScreenResult[] | undefined;
  readonly onUseResult?: ((key: string) => void) | undefined;
  readonly onImportVideo?: (() => void) | undefined;
}

function matches(binding: GreenScreenBinding, input: PromptContentConnection): boolean {
  return (
    binding.key === input.key &&
    binding.target.kind !== "url" &&
    sameMediaReferenceTarget(binding.target, input.target)
  );
}

function choiceValue(input: PromptContentConnection): string {
  return JSON.stringify([input.key, input.target]);
}

function BindingSelect({
  label,
  placeholder,
  binding,
  inputs,
  kinds,
  onChange,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly binding: GreenScreenBinding | null;
  readonly inputs: readonly PromptContentConnection[];
  readonly kinds: readonly ("image" | "video")[];
  readonly onChange: (binding: GreenScreenBinding | null) => void;
}) {
  const available = inputs.filter(
    (input) => input.kind !== "audio" && kinds.includes(input.kind) && input.target.kind !== "url",
  );
  const selected = binding ? available.find((input) => matches(binding, input)) : undefined;
  const missing = binding != null && selected == null;
  return (
    <label className="green-screen__field">
      <span>{label}</span>
      <select
        value={missing ? "unavailable" : selected ? choiceValue(selected) : ""}
        aria-invalid={missing || undefined}
        onChange={(event) => {
          if (!event.target.value) {
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
          <option key={choiceValue(input)} value={choiceValue(input)}>
            {input.kind === "video" ? "视频" : "图片"} · {input.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function GreenScreenSection({
  config,
  inputs,
  modelId,
  onChange,
  onGenerate,
  busy = false,
  results = [],
  onUseResult,
  onImportVideo,
}: GreenScreenSectionProps) {
  const current = config ?? createGreenScreenConfig();
  const [expanded, setExpanded] = useState(current.enabled);
  const [reviewing, setReviewing] = useState(current.preparationMode === "existing");
  const [candidate, setCandidate] = useState<GreenScreenBinding | null>(null);
  const issueId = useId();
  const resolved = resolveGreenScreen(current, inputs, modelId);
  const update = (patch: Partial<GreenScreenConfig>) => onChange({ ...current, ...patch });
  const step = current.phase === "composite" ? 3 : reviewing ? 2 : 1;
  const validCandidate =
    candidate && inputs.some((input) => input.kind === "video" && matches(candidate, input));
  const alreadySelected =
    candidate && current.foregrounds.some((binding) => binding.key === candidate.key);
  const foregroundsReady =
    current.foregrounds.length > 0 &&
    current.foregrounds.every((binding) =>
      inputs.some((input) => input.kind === "video" && matches(binding, input)),
    );
  const canGenerate =
    current.phase === "composite" || (current.preparationMode !== "existing" && !reviewing);

  const foregroundPicker = (
    <div className="green-screen__group" aria-label="已选绿幕前景">
      <BindingSelect
        label="添加已连接的绿幕视频"
        placeholder="请选择已检查的绿幕视频"
        binding={candidate}
        inputs={inputs}
        kinds={["video"]}
        onChange={setCandidate}
      />
      <button
        type="button"
        className="green-screen__button"
        disabled={!validCandidate || Boolean(alreadySelected)}
        onClick={() => {
          if (!candidate || !validCandidate || alreadySelected) return;
          update({ foregrounds: [...current.foregrounds, candidate] });
          setCandidate(null);
        }}
      >
        添加为绿幕前景
      </button>
      {current.foregrounds.length > 0 ? (
        <ol className="green-screen__foregrounds">
          {current.foregrounds.map((binding, index) => {
            const connected = inputs.some(
              (input) => input.kind === "video" && matches(binding, input),
            );
            return (
              <li key={JSON.stringify([binding.key, binding.target])}>
                <span>
                  前景 {index + 1} · {binding.name}
                  {connected ? "" : "（已断开/来源已变化）"}
                </span>
                <button
                  type="button"
                  className="green-screen__button"
                  aria-label={`移除绿幕前景 ${index + 1} ${binding.name}`}
                  onClick={() =>
                    update({
                      foregrounds: current.foregrounds.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                >
                  移除
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="green-screen__hint">
          尚未选用绿幕前景。连线后在这里明确添加，或选用下方制作结果。
        </p>
      )}
    </div>
  );

  return (
    <details
      className="green-screen nodrag nowheel"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="green-screen__summary">
        <strong>无缝绿幕编辑</strong>
        <span className="green-screen__state">
          {current.enabled
            ? busy
              ? "正在生成"
              : `步骤 ${step} · ${resolved.issue ? "待完善" : "已就绪"}`
            : "未启用"}
        </span>
      </summary>
      <div className="green-screen__body">
        <label className="green-screen__check">
          <input
            type="checkbox"
            checked={current.enabled}
            disabled={busy}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          <span>启用无缝绿幕编辑</span>
        </label>
        <p className="green-screen__hint">
          先制作绿幕主体，检查并选用，再把主体融入新场景。每步可单独重新生成，任务进度与结果保存在任务历史中。
        </p>
        <details className="green-screen__help">
          <summary>绿幕视频怎么做？</summary>
          <p className="green-screen__hint">
            AI
            制作：描述主体与完整动作，可选择主体参考图；或选择现有视频，把背景改为均匀纯绿并保留主体和动作。生成后检查头发、手指、衣物边缘及动作是否完整，再选用这一版。
          </p>
          <p className="green-screen__hint">
            实拍制作：使用均匀、无褶皱的绿色背景；主体衣物和道具避开绿色，主体与幕布留出距离，背景和主体分别布光，减少阴影与绿光反射。导入拍好的视频后，在“检查选用”中添加为绿幕前景。
          </p>
          <p className="green-screen__hint">
            融合成片：可组合多段绿幕主体，选择场景图片或视频，也可直接描述新场景；写明各主体出现时间、位置、光影和特效互动。
          </p>
        </details>
        {current.enabled ? (
          <fieldset className="green-screen__controls" disabled={busy}>
            <legend className="sr-only">绿幕制作与融合设置</legend>
            <div className="green-screen__steps" aria-label="绿幕工作流程">
              {["制作绿幕", "检查选用", "融合成片"].map((label, index) => (
                <button
                  key={label}
                  type="button"
                  className="green-screen__button"
                  aria-current={step === index + 1 ? "step" : undefined}
                  onClick={() => {
                    setReviewing(index === 1);
                    update({ phase: index === 2 ? "composite" : "prepare" });
                  }}
                >
                  {index + 1} · {label}
                </button>
              ))}
            </div>
            <p className="green-screen__hint">
              上方正文保留并随本步提交。请用本区选择素材角色；自由 @
              引用请写在上方正文。每步使用本步所选素材及正文 @ 引用，未选用的连接素材不会自动参与。
            </p>
            {onImportVideo ? (
              <button type="button" className="green-screen__button" onClick={onImportVideo}>
                导入绿幕或原视频
              </button>
            ) : null}
            {current.phase === "prepare" ? (
              <>
                <label className="green-screen__field">
                  <span>绿幕制作方式</span>
                  <select
                    value={current.preparationMode}
                    onChange={(event) => {
                      const preparationMode = event.target.value;
                      if (
                        preparationMode === "generate" ||
                        preparationMode === "convert" ||
                        preparationMode === "existing"
                      ) {
                        setReviewing(preparationMode === "existing");
                        update({ preparationMode });
                      }
                    }}
                  >
                    <option value="generate">AI 生成绿幕主体</option>
                    <option value="convert">现有视频转绿幕</option>
                    <option value="existing">使用已有绿幕视频</option>
                  </select>
                </label>
                {current.preparationMode !== "existing" && !reviewing ? (
                  <>
                    {current.preparationMode === "convert" ? (
                      <BindingSelect
                        label="待转绿幕的原视频"
                        placeholder="请选择原视频"
                        binding={current.source}
                        inputs={inputs}
                        kinds={["video"]}
                        onChange={(source) => update({ source })}
                      />
                    ) : (
                      <BindingSelect
                        label="主体参考图"
                        placeholder="仅使用主体描述"
                        binding={current.subjectReference}
                        inputs={inputs}
                        kinds={["image"]}
                        onChange={(subjectReference) => update({ subjectReference })}
                      />
                    )}
                    <label className="green-screen__field">
                      <span>主体与动作描述</span>
                      <textarea
                        rows={3}
                        value={current.subject}
                        placeholder="例如：穿银色盔甲的角色全身入镜，0–3 秒拔剑，3–6 秒向左挥剑，保持手脚完整。"
                        onChange={(event) => update({ subject: event.target.value })}
                      />
                    </label>
                    <p className="green-screen__hint">
                      制作时自动要求均匀纯绿色背景、主体完整及清晰边缘；新场景和融合要求在第 3
                      步使用。
                    </p>
                  </>
                ) : null}
                <section className="green-screen__group" aria-label="检查并选用绿幕">
                  <strong>2 · 检查并选用绿幕</strong>
                  <p className="green-screen__hint">
                    先播放视频，检查主体边缘、动作与镜头是否符合要求。满意后明确选用；需要调整可返回制作绿幕并重新生成。
                  </p>
                  {results.length > 0 ? (
                    <div className="green-screen__results">
                      {results.map((result) => (
                        <div className="green-screen__result" key={result.key}>
                          <span>{result.name}</span>
                          <video
                            src={result.src}
                            controls
                            preload="metadata"
                            aria-label={`绿幕预览 ${result.name}`}
                          />
                          {onUseResult ? (
                            <button
                              type="button"
                              className="green-screen__button"
                              onClick={() => onUseResult(result.key)}
                            >
                              使用这版绿幕进入合成
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="green-screen__hint">
                      暂无本步制作结果。生成后先检查边缘和动作，再选择用于合成的版本；已有绿幕可直接从连线素材中添加。
                    </p>
                  )}
                  {foregroundPicker}
                  <button
                    type="button"
                    className="green-screen__button"
                    disabled={!foregroundsReady}
                    onClick={() => update({ phase: "composite" })}
                  >
                    确认绿幕并进入合成
                  </button>
                </section>
              </>
            ) : (
              <>
                <strong>3 · 融合成片</strong>
                {foregroundPicker}
                <BindingSelect
                  label="背景场景参考"
                  placeholder="仅使用新场景描述"
                  binding={current.background}
                  inputs={inputs}
                  kinds={["image", "video"]}
                  onChange={(background) => update({ background })}
                />
                <label className="green-screen__field">
                  <span>新场景描述</span>
                  <textarea
                    rows={3}
                    value={current.scene}
                    placeholder="例如：夜晚雨中的街道，角色站在画面左侧，背景霓虹灯映在地面上。"
                    onChange={(event) => update({ scene: event.target.value })}
                  />
                </label>
                <label className="green-screen__field">
                  <span>光影、时序与特效互动</span>
                  <textarea
                    rows={3}
                    value={current.integration}
                    placeholder="例如：前景 1 在 0 秒出现，前景 2 在 3 秒从右侧入画；暖色侧光与接触阴影，挥剑时电光跟随剑尖，保留主体原有动作。"
                    onChange={(event) => update({ integration: event.target.value })}
                  />
                </label>
                <label className="green-screen__field">
                  <span>成片声音</span>
                  <select
                    value={current.audio}
                    onChange={(event) => {
                      const audio = event.target.value;
                      if (audio === "preserve" || audio === "mute" || audio === "scene")
                        update({ audio });
                    }}
                  >
                    <option value="preserve">保留主体原声</option>
                    <option value="mute">静音</option>
                    <option value="scene">按新场景生成声音</option>
                  </select>
                </label>
              </>
            )}
            {resolved.issue ? (
              <p className="green-screen__issue" role="alert" id={issueId}>
                {resolved.issue}
              </p>
            ) : null}
            {busy ? (
              <p className="green-screen__hint" role="status">
                本步正在生成，完成后可检查结果；也可在任务历史中查看进度。
              </p>
            ) : null}
            {onGenerate && canGenerate ? (
              <button
                type="button"
                className="green-screen__button green-screen__primary"
                disabled={busy || Boolean(resolved.issue)}
                aria-describedby={resolved.issue ? issueId : undefined}
                onClick={onGenerate}
              >
                {busy
                  ? "正在生成…"
                  : current.phase === "composite"
                    ? "生成融合成片"
                    : current.preparationMode === "convert"
                      ? "将原视频转为绿幕"
                      : "生成绿幕视频"}
              </button>
            ) : null}
            <details className="green-screen__preview">
              <summary>查看本步绿幕提示词</summary>
              <p className="green-screen__hint">以下内容与上方正文一同提交。</p>
              <textarea
                className="green-screen__preview-text"
                readOnly
                rows={8}
                aria-label="绿幕提示词预览"
                value={resolved.preview}
              />
            </details>
          </fieldset>
        ) : null}
      </div>
    </details>
  );
}
