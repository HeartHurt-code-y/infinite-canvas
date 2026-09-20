import { Icon } from "../../components/Icon";
import { useEffect, useRef, useState } from "react";

import { ImeInput, ImeTextarea } from "../../components/ImeTextField";
import { toMediaSrc } from "../../lib/backend";
import {
  COMIC_DRAMA_STAGES,
  COMIC_DRAMA_STAGE_LABELS,
  type ComicDramaReview,
  type ComicDramaWorkflowOptions,
} from "./comicDramaWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

interface ComicDramaConfigurationProps {
  readonly options: ComicDramaWorkflowOptions;
  readonly brief: string;
  readonly disabled: boolean;
  readonly onChange: (options: ComicDramaWorkflowOptions) => void;
  readonly onBriefChange: (brief: string) => void;
}

export function ComicDramaConfiguration({
  options,
  brief,
  disabled,
  onChange,
  onBriefChange,
}: ComicDramaConfigurationProps) {
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const importTarget = useRef({ disabled, onChange });
  useEffect(() => {
    importTarget.current = { disabled, onChange };
  }, [disabled, onChange]);
  const populatedCount = options.episodes.filter((episode) => episode.script.trim()).length;

  const importFiles = async (files: readonly File[]) => {
    if (!files.length) return;
    setImportError("");
    if (files.some((file) => !/\.(txt|md|markdown)$/i.test(file.name))) {
      setImportError("请选择 TXT 或 Markdown 剧本文件。");
      return;
    }
    const existing = options.episodes.some((episode) => episode.script.trim())
      ? options.episodes
      : [];
    if (existing.length + files.length > 10) {
      setImportError("一个工作流最多制作 10 集，请减少文件数量或移除已有集。");
      return;
    }
    setImporting(true);
    try {
      const episodes = await Promise.all(
        [...files]
          .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }))
          .map(async (file) => ({
            id: crypto.randomUUID(),
            title: file.name.replace(/\.(txt|md|markdown)$/i, ""),
            script: (await file.text()).replace(/^\uFEFF/, ""),
          })),
      );
      if (!importTarget.current.disabled) {
        importTarget.current.onChange({ ...options, episodes: [...existing, ...episodes] });
      }
    } catch {
      setImportError("剧本文件读取失败，请重新选择文件。");
    } finally {
      setImporting(false);
    }
  };

  return (
    <details className="canvas-knowledge-workflow__models canvas-ai-film-workflow__scope canvas-comic-drama-workflow__scope">
      <summary>
        <span className="canvas-knowledge-workflow__models-title">分集剧本与制作设置</span>
        <span>{populatedCount ? `${populatedCount} 集剧本已就绪` : "添加或导入剧本"}</span>
        <Icon name="caret-down" aria-hidden="true" size="md" />
      </summary>
      <fieldset disabled={disabled || importing} className="canvas-comic-drama-workflow__settings">
        <label className="canvas-comic-drama-workflow__import">
          <span>导入分集剧本</span>
          <input
            type="file"
            aria-label="导入漫剧分集剧本"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void importFiles(files);
            }}
          />
          <small>支持多个 TXT / Markdown 文件，按文件名排序，每个文件对应一集，最多 10 集。</small>
        </label>
        {importing ? <p role="status">正在读取剧本…</p> : null}
        {importError ? <p role="alert">{importError}</p> : null}
        {options.episodes.map((episode, index) => (
          <fieldset className="canvas-comic-drama-workflow__episode" key={episode.id}>
            <legend>第 {index + 1} 集</legend>
            <div className="canvas-comic-drama-workflow__episode-heading">
              <label>
                <span>集名</span>
                <ImeInput
                  aria-label={`第 ${index + 1} 集集名`}
                  value={episode.title}
                  onValueChange={(value) =>
                    onChange({
                      ...options,
                      episodes: options.episodes.map((item) =>
                        item.id === episode.id ? { ...item, title: value } : item,
                      ),
                    })
                  }
                />
              </label>
              <button
                type="button"
                disabled={options.episodes.length <= 1}
                aria-label={`移除第 ${index + 1} 集`}
                onClick={() =>
                  onChange({
                    ...options,
                    episodes: options.episodes.filter((item) => item.id !== episode.id),
                  })
                }
              >
                移除
              </button>
            </div>
            <label className="canvas-knowledge-workflow__brief">
              <span>完整剧本</span>
              <ImeTextarea
                rows={5}
                aria-label={`第 ${index + 1} 集剧本`}
                value={episode.script}
                placeholder="粘贴小说、创意或已有剧本。依次完成剧本共创、风格锁定、服化道、导演分镜与执行提示词；每阶段审阅确认后继续。"
                onValueChange={(value) =>
                  onChange({
                    ...options,
                    episodes: options.episodes.map((item) =>
                      item.id === episode.id ? { ...item, script: value } : item,
                    ),
                  })
                }
              />
            </label>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={options.episodes.length >= 10}
          onClick={() =>
            onChange({
              ...options,
              episodes: [
                ...options.episodes,
                {
                  id: crypto.randomUUID(),
                  title: `第 ${options.episodes.length + 1} 集`,
                  script: "",
                },
              ],
            })
          }
        >
          添加一集
        </button>
        <label className="canvas-knowledge-workflow__brief">
          <span>视觉风格</span>
          <ImeTextarea
            aria-label="漫剧视觉风格"
            rows={2}
            value={options.visualStyle}
            onValueChange={(value) => onChange({ ...options, visualStyle: value })}
          />
        </label>
        <div className="canvas-comic-drama-workflow__format">
          <label>
            画幅
            <select
              aria-label="漫剧画幅"
              value={options.aspectRatio}
              onChange={(event) => onChange({ ...options, aspectRatio: event.target.value })}
            >
              <option value="9:16">竖屏 9:16</option>
              <option value="16:9">横屏 16:9</option>
              <option value="1:1">方形 1:1</option>
            </select>
          </label>
          <label>
            交付方式
            <select
              aria-label="漫剧交付方式"
              value={options.deliverable}
              onChange={(event) =>
                onChange({ ...options, deliverable: event.target.value as "video" | "documents" })
              }
            >
              <option value="video">制作完整成片</option>
              <option value="documents">仅制作分集文档</option>
            </select>
          </label>
        </div>
        <label className="canvas-knowledge-workflow__brief">
          <span>补充制作要求（可选）</span>
          <ImeTextarea
            aria-label="漫剧制作要求"
            rows={2}
            value={brief}
            placeholder="例如：保留逐字对白，强调人物关系和悬念。"
            onValueChange={onBriefChange}
          />
        </label>
      </fieldset>
      <small>角色音色在本节点交付设计文档，当前不自动生成独立配音音轨。</small>
    </details>
  );
}

function ReviewDocument({
  title,
  review,
}: {
  readonly title: string;
  readonly review: ComicDramaReview | null;
}) {
  const labels = { PASS: "通过", REVISE: "待修订", NEEDS_DECISION: "待确认" } as const;
  return (
    <details className="canvas-knowledge-workflow__deliverables">
      <summary>
        {title} · {review ? labels[review.result] : "待检查"}
      </summary>
      {review ? (
        <div>
          <pre>{review.report}</pre>
          {review.repairInstructions ? <p>修订要求：{review.repairInstructions}</p> : null}
          {review.question ? <p>待确认：{review.question}</p> : null}
          {review.recommendation ? <p>建议：{review.recommendation}</p> : null}
        </div>
      ) : null}
    </details>
  );
}

export function ComicDramaDeliverables({
  checkpoint,
  onExport,
}: {
  readonly checkpoint: KnowledgeVideoWorkflowCheckpoint;
  readonly onExport?: () => void;
}) {
  const drama = checkpoint.comicDrama;
  if (
    !drama?.episodes.some((episode) =>
      COMIC_DRAMA_STAGES.some((stage) => episode.stages[stage]?.artifact),
    )
  )
    return null;
  const assets = checkpoint.film?.assets.length ? checkpoint.film.assets : drama.sharedAssets;
  return (
    <section
      className="canvas-ai-film-workflow__artifacts canvas-comic-drama-workflow__artifacts"
      aria-label="漫剧阶段交付物"
    >
      <strong>{checkpoint.phase === "done" ? "漫剧交付物已就绪" : "分集制作进展"}</strong>
      {onExport ? (
        <button type="button" onClick={onExport}>
          导出漫剧制作文档
        </button>
      ) : null}
      {drama.episodes.map((episode) => (
        <details className="canvas-knowledge-workflow__deliverables" key={episode.id}>
          <summary>{episode.title}</summary>
          <div>
            {COMIC_DRAMA_STAGES.map((stage) => {
              const run = episode.stages[stage];
              if (!run?.artifact) return null;
              return (
                <details className="canvas-knowledge-workflow__deliverables" key={stage}>
                  <summary>
                    {COMIC_DRAMA_STAGE_LABELS[stage]} · v{run.artifact.version} ·{" "}
                    {run.passed
                      ? run.approvedVersion === run.artifact.version
                        ? "已确认"
                        : "检查通过，待人工确认"
                      : "待检查或修订"}
                  </summary>
                  <div>
                    <small>依据：{run.artifact.inputSummary}</small>
                    <pre>{run.artifact.content}</pre>
                    <ReviewDocument title="业务检查" review={run.businessReview} />
                    <ReviewDocument title="内容检查" review={run.contentReview} />
                    {run.history.length ? (
                      <details className="canvas-knowledge-workflow__deliverables">
                        <summary>历史版本（{run.history.length}）</summary>
                        <div>
                          {run.history.map((artifact) => (
                            <details key={`${artifact.version}-${artifact.createdAt}`}>
                              <summary>v{artifact.version}</summary>
                              <small>依据：{artifact.inputSummary}</small>
                              <pre>{artifact.content}</pre>
                            </details>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
        </details>
      ))}
      {assets.some((asset) => asset.path) ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>跨集共享角色、场景与道具图</summary>
          <div className="canvas-ai-film-workflow__assets">
            {assets
              .filter((asset) => asset.path)
              .map((asset) => (
                <figure key={asset.id}>
                  <img src={toMediaSrc(asset.path!)} alt={asset.name} loading="lazy" />
                  <figcaption>{asset.name}</figcaption>
                </figure>
              ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
