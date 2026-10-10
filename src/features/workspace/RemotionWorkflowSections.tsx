import { Icon } from "../../components/Icon";
import { toMediaSrc } from "../../lib/backend";
import { ANIMATION_TEMPLATES, type RemotionWorkflowOptions } from "./remotionWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

interface RemotionConfigurationProps {
  readonly options: RemotionWorkflowOptions;
  readonly disabled: boolean;
  readonly onChange: (options: RemotionWorkflowOptions) => void;
}

export function RemotionConfiguration({ options, disabled, onChange }: RemotionConfigurationProps) {
  return (
    <details className="canvas-knowledge-workflow__models canvas-remotion-workflow__scope">
      <summary>
        <span className="canvas-knowledge-workflow__models-title">动画与导出设置</span>
        <span>
          {options.width} × {options.height} ·{" "}
          {options.format === "both" ? "GIF + MP4" : options.format.toUpperCase()}
        </span>
        <Icon name="caret-down" aria-hidden="true" size="md" />
      </summary>
      <fieldset disabled={disabled} className="canvas-remotion-workflow__settings">
        <label>
          动画模板
          <select
            aria-label="动画模板"
            value={options.template}
            onChange={(event) =>
              onChange({
                ...options,
                template: event.target.value as RemotionWorkflowOptions["template"],
              })
            }
          >
            <option value="auto">根据描述自动匹配</option>
            {Object.entries(ANIMATION_TEMPLATES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          视觉主题
          <select
            aria-label="动画视觉主题"
            value={options.theme}
            onChange={(event) =>
              onChange({
                ...options,
                theme: event.target.value as RemotionWorkflowOptions["theme"],
              })
            }
          >
            <option value="morandi">莫兰迪</option>
            <option value="light">明亮</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label>
          画面尺寸
          <select
            aria-label="动画画面尺寸"
            value={`${options.width}x${options.height}`}
            onChange={(event) => {
              const [width, height] = event.target.value.split("x").map(Number);
              if (width && height) onChange({ ...options, width, height });
            }}
          >
            <option value="800x600">800 × 600 · 4:3</option>
            <option value="1280x720">1280 × 720 · 横屏</option>
            <option value="720x1280">720 × 1280 · 竖屏</option>
          </select>
        </label>
        <label>
          时长（秒）
          <input
            aria-label="动画时长"
            type="number"
            min={6}
            max={30}
            step={1}
            value={options.durationSeconds}
            onChange={(event) => {
              const durationSeconds = event.currentTarget.valueAsNumber;
              if (
                Number.isInteger(durationSeconds) &&
                durationSeconds >= 6 &&
                durationSeconds <= 30
              )
                onChange({ ...options, durationSeconds });
            }}
          />
        </label>
        <label>
          导出格式
          <select
            aria-label="动画导出格式"
            value={options.format}
            onChange={(event) =>
              onChange({
                ...options,
                format: event.target.value as RemotionWorkflowOptions["format"],
              })
            }
          >
            <option value="gif">GIF 动图</option>
            <option value="mp4">MP4 视频</option>
            <option value="both">GIF 动图 + MP4 视频</option>
          </select>
        </label>
        <small>自动匹配布局、检查内容并在本机渲染，导出文件与可编辑工程。</small>
      </fieldset>
    </details>
  );
}

interface RemotionDeliverablesProps {
  readonly checkpoint: KnowledgeVideoWorkflowCheckpoint;
  readonly onExport?: () => void;
  readonly onRevealProject?: () => void;
  readonly onRevealResult?: () => void;
}

export function RemotionDeliverables({
  checkpoint,
  onExport,
  onRevealProject,
  onRevealResult,
}: RemotionDeliverablesProps) {
  const state = checkpoint.remotion;
  if (!state) return null;
  const { plan, renderJob } = state;
  const hasMedia = [renderJob?.gifPath, renderJob?.videoPath, renderJob?.previewPath].some(Boolean);
  if (!plan && !hasMedia) return null;
  const reviewLabel = (result: string) =>
    result === "PASS" ? "通过" : result === "REVISE" ? "需要修订" : "需要确认";
  return (
    <section className="canvas-remotion-workflow__deliverables" aria-label="动画交付物">
      {hasMedia ? (
        <div className="canvas-remotion-workflow__media">
          <strong>
            {renderJob?.status === "succeeded" ? "动画交付物已就绪" : "已生成的动画文件"}
          </strong>
          {renderJob?.gifPath ? (
            <figure>
              <img src={toMediaSrc(renderJob.gifPath)} alt={`${plan?.title ?? "动画"} GIF 动图`} />
              <figcaption>GIF 动图</figcaption>
            </figure>
          ) : null}
          {renderJob?.videoPath ? (
            <figure>
              <video
                aria-label="动画 MP4 视频"
                controls
                preload="metadata"
                src={toMediaSrc(renderJob.videoPath)}
              />
              <figcaption>MP4 视频</figcaption>
            </figure>
          ) : null}
          {renderJob?.previewPath ? (
            <details className="canvas-knowledge-workflow__deliverables">
              <summary>静态预览图</summary>
              <img
                src={toMediaSrc(renderJob.previewPath)}
                alt={`${plan?.title ?? "动画"} 静态预览`}
                loading="lazy"
              />
            </details>
          ) : null}
        </div>
      ) : null}
      <div className="canvas-remotion-workflow__delivery-actions">
        {hasMedia && onRevealResult ? (
          <button type="button" onClick={onRevealResult}>
            查看导出文件
          </button>
        ) : null}
        {plan && onExport ? (
          <button type="button" onClick={onExport}>
            导出动画制作文档
          </button>
        ) : null}
        {renderJob?.projectPath && onRevealProject ? (
          <button type="button" onClick={onRevealProject}>
            打开可编辑工程
          </button>
        ) : null}
      </div>
      {plan ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>动画方案 · {ANIMATION_TEMPLATES[plan.template]}</summary>
          <div>
            <strong>{plan.title}</strong>
            {plan.subtitle ? <p>{plan.subtitle}</p> : null}
            <p>匹配依据：{state.matchReason || "按所选模板制作"}</p>
            <p>
              {plan.width} × {plan.height} · {plan.durationInFrames / plan.fps} 秒
            </p>
            <ol>
              {plan.elements.map((element) => (
                <li key={element.id}>
                  <strong>{element.label}</strong>
                  {element.detail ? <p>{element.detail}</p> : null}
                  {element.value != null ? <span>数值：{element.value}</span> : null}
                </li>
              ))}
            </ol>
            {plan.connections.length ? (
              <ul aria-label="动画元素关系">
                {plan.connections.map((connection, index) => (
                  <li key={index}>
                    {plan.elements.find((element) => element.id === connection.from)?.label ??
                      connection.from}{" "}
                    →{" "}
                    {plan.elements.find((element) => element.id === connection.to)?.label ??
                      connection.to}
                    {connection.label ? ` · ${connection.label}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      ) : null}
      {state.review ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>内容与布局检查 · {reviewLabel(state.review.result)}</summary>
          <div>
            <pre>{state.review.report}</pre>
            {state.review.repairInstructions ? <p>{state.review.repairInstructions}</p> : null}
          </div>
        </details>
      ) : null}
      {state.history.length ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>历史版本（{state.history.length}）</summary>
          <div>
            {state.history.map((entry, index) => (
              <details key={index}>
                <summary>
                  版本 {index + 1} · {entry.plan.title}
                </summary>
                <p>{ANIMATION_TEMPLATES[entry.plan.template]}</p>
                <ul>
                  {entry.plan.elements.map((element) => (
                    <li key={element.id}>
                      {element.label}
                      {element.detail ? `：${element.detail}` : ""}
                    </li>
                  ))}
                </ul>
                {entry.review ? (
                  <pre>
                    {reviewLabel(entry.review.result)} · {entry.review.report}
                  </pre>
                ) : null}
              </details>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
