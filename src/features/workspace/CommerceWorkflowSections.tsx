import { WorkflowFieldHelp } from "./WorkflowGuidance";
import { Icon } from "../../components/Icon";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useId, useState } from "react";

import { ImeInput, ImeTextarea } from "../../components/ImeTextField";
import { MarkdownView } from "../../components/MarkdownView";
import { toMediaSrc } from "../../lib/backend";
import {
  COMMERCE_STAGES,
  COMMERCE_STAGE_LABELS,
  COMMERCE_STORY_TYPES,
  type CommerceFact,
  type CommerceWorkflowOptions,
} from "./commerceWorkflowModel";
import { RequiredMark } from "./workflowFieldRequirements";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";

interface CommerceConfigurationProps {
  readonly options: CommerceWorkflowOptions;
  readonly brief: string;
  readonly disabled: boolean;
  readonly onChange: (options: CommerceWorkflowOptions) => void;
  readonly onBriefChange: (brief: string) => void;
  readonly onPickMaterials?: () => Promise<void>;
  readonly onRemoveMaterial?: (localPath: string) => void;
}

export function CommerceConfiguration({
  options,
  brief,
  disabled,
  onChange,
  onBriefChange,
  onPickMaterials,
  onRemoveMaterial,
}: CommerceConfigurationProps) {
  const [picking, setPicking] = useState(false);
  const [materialError, setMaterialError] = useState<unknown>(null);
  const materialErrorId = useId();
  const urlsErrorId = useId();
  const hasProductImage = options.materials.some((material) => material.kind === "image");
  const urls = options.productUrl.split(/\r?\n/).filter((url) => url.trim());
  const pickMaterials = async () => {
    if (!onPickMaterials || disabled || picking) return;
    setPicking(true);
    setMaterialError(null);
    try {
      await onPickMaterials();
    } catch (error) {
      setMaterialError(error);
    } finally {
      setPicking(false);
    }
  };

  return (
    <details className="canvas-knowledge-workflow__models canvas-commerce-workflow__scope">
      <summary>
        <span className="canvas-knowledge-workflow__models-title">商品资料与制作设置</span>
        <span>{options.productName.trim() || "添加商品资料"}</span>
        <Icon name="caret-down" aria-hidden="true" size="md" />
      </summary>
      <fieldset disabled={disabled || picking} className="canvas-commerce-workflow__settings">
        <div className="canvas-commerce-workflow__format">
          <label>
            制作模式
            <select
              aria-label="带货制作模式"
              value={options.mode}
              onChange={(event) =>
                onChange({ ...options, mode: event.target.value as "quick" | "full" })
              }
            >
              <option value="quick">快速模式 · 15 秒四镜头</option>
              <option value="full">完整模式 · 五阶段制作</option>
            </select>
            <WorkflowFieldHelp>
              快速模式围绕卖点安排 15
              秒四镜头，适合先尝试一个短剧情；完整模式依次做产品研究、创意、剧本、分镜与资产。
            </WorkflowFieldHelp>
          </label>
          <label>
            剧情类型
            <select
              aria-label="带货剧情类型"
              value={options.storyType}
              onChange={(event) => onChange({ ...options, storyType: event.target.value })}
            >
              {!COMMERCE_STORY_TYPES.some((type) => type === options.storyType) ? (
                <option value={options.storyType}>{options.storyType}</option>
              ) : null}
              {COMMERCE_STORY_TYPES.map((type) => (
                <option value={type} key={type}>
                  {type}
                </option>
              ))}
            </select>
            <WorkflowFieldHelp>
              决定用什么故事带出商品；不确定先用智能推荐。职场、宿舍或家庭适合对应生活场景，无对白视觉流适合靠画面表达。
            </WorkflowFieldHelp>
          </label>
        </div>
        <small>
          {options.mode === "quick"
            ? "围绕商品卖点自动编排 15 秒四镜头剧情，检查后生成交付物。"
            : "产品研究、剧情创意、带货剧本、分镜提示词和一致性资产依次完成，自动检查与修订。"}
        </small>
        <label>
          商品名称
          <ImeInput
            aria-label="带货商品名称"
            value={options.productName}
            placeholder="例如：便携咖啡杯"
            onValueChange={(value) => onChange({ ...options, productName: value })}
          />
          <WorkflowFieldHelp>
            填写具体品名或型号，帮助识别主推商品，例如“500 mL 便携咖啡杯”；其他资料充分时可留空。
          </WorkflowFieldHelp>
        </label>
        <label className="canvas-knowledge-workflow__brief">
          <span>商品或资料链接</span>
          <ImeTextarea
            rows={2}
            aria-label="带货商品链接"
            aria-describedby={urls.length > 4 ? urlsErrorId : undefined}
            value={options.productUrl}
            placeholder="每行一个链接，最多 4 个"
            onValueChange={(value) => onChange({ ...options, productUrl: value })}
          />
          <small>自动读取公开商品资料；链接读取失败时可补充下方文字或文档。</small>
          <WorkflowFieldHelp>
            每行一个公开 HTTP(S) 商品页或资料页，最多 4
            个；只会读取这些页面。需要登录或读取失败的内容请补充文字或文档。
          </WorkflowFieldHelp>
        </label>
        {urls.length > 4 ? (
          <ErrorAlert workflow id={urlsErrorId} error="最多填写 4 个资料链接，请移除多余链接。" />
        ) : null}
        <label className="canvas-knowledge-workflow__brief">
          <span>商品事实与卖点</span>
          <ImeTextarea
            rows={4}
            aria-label="带货商品事实与卖点"
            value={options.productFacts}
            placeholder="填写已确认的材质、规格、用途和卖点；价格、优惠或功效请提供依据。"
            onValueChange={(value) => onChange({ ...options, productFacts: value })}
          />
          <WorkflowFieldHelp>
            写清材质、规格、用途和有依据的卖点，例如“500
            mL，杯盖可拆洗”；价格、优惠与功效只填已确认信息。
          </WorkflowFieldHelp>
        </label>
        <label>
          目标受众
          <ImeInput
            aria-label="带货目标受众"
            value={options.audience}
            placeholder="例如：通勤上班族"
            onValueChange={(value) => onChange({ ...options, audience: value })}
          />
          <WorkflowFieldHelp>
            描述谁会买、在哪使用、有什么需要，例如“每天通勤、想减少漏水的上班族”；留空由现有商品资料推断。
          </WorkflowFieldHelp>
        </label>
        <section className="canvas-commerce-workflow__materials" aria-label="商品图片与文档">
          <div className="canvas-commerce-workflow__materials-heading">
            <strong>
              {/* 只有成片模式才必须给真实商品图；文档模式这一块是选填，不标红星。 */}
              {options.deliverable === "video" ? (
                <RequiredMark>商品图片与文档</RequiredMark>
              ) : (
                "商品图片与文档"
              )}
            </strong>
            <button
              type="button"
              disabled={!onPickMaterials}
              aria-describedby={materialError ? materialErrorId : undefined}
              onClick={() => void pickMaterials()}
            >
              {picking ? "正在选择资料…" : "添加商品资料"}
            </button>
          </div>
          <small>
            支持图片、PDF、TXT / Markdown。制作成片需要真实商品图，生成时保留原图作为参考。
          </small>
          <WorkflowFieldHelp>
            上传本款商品清晰的全貌、细节或使用照片，资料文档可补充规格依据；请避免混入其他型号。仅做文档时可用文字资料先规划。
          </WorkflowFieldHelp>
          {options.materials.length ? (
            <ul>
              {options.materials.map((material) => (
                <li key={material.localPath}>
                  {material.kind === "image" ? (
                    <img
                      src={toMediaSrc(material.localPath)}
                      alt={material.displayName}
                      loading="lazy"
                    />
                  ) : (
                    <span aria-hidden="true">文档</span>
                  )}
                  <span>
                    {material.displayName}
                    <small>{(material.byteSize / 1024 / 1024).toFixed(2)} MB</small>
                  </span>
                  {onRemoveMaterial ? (
                    <button
                      type="button"
                      aria-label={`移除商品资料 ${material.displayName}`}
                      onClick={() => onRemoveMaterial(material.localPath)}
                    >
                      移除
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {!hasProductImage && options.deliverable === "video" ? (
            <p>请添加真实商品图后开始制作成片。</p>
          ) : null}
          {materialError ? (
            <ErrorAlert workflow id={materialErrorId} error={materialError} />
          ) : null}
        </section>
        <div className="canvas-commerce-workflow__format">
          <label>
            画幅
            <select
              aria-label="带货画幅"
              value={options.aspectRatio}
              onChange={(event) => onChange({ ...options, aspectRatio: event.target.value })}
            >
              <option value="9:16">竖屏 9:16</option>
              <option value="16:9">横屏 16:9</option>
              <option value="1:1">方形 1:1</option>
            </select>
            <WorkflowFieldHelp>
              竖屏 9:16 适合手机短视频，横屏 16:9 适合横屏播放，方形 1:1 适合方形位置；预置竖屏。
            </WorkflowFieldHelp>
          </label>
          <label>
            交付方式
            <select
              aria-label="带货交付方式"
              value={options.deliverable}
              onChange={(event) =>
                onChange({ ...options, deliverable: event.target.value as "video" | "documents" })
              }
            >
              <option value="video">制作完整成片</option>
              <option value="documents">仅制作文档与提示词</option>
            </select>
            <WorkflowFieldHelp>
              完整成片会继续制作图片资产、视频片段并合成，需要真实商品图；仅文档与提示词适合先检查剧情和事实。
            </WorkflowFieldHelp>
          </label>
        </div>
        <label className="canvas-knowledge-workflow__brief">
          <span>补充制作要求</span>
          <ImeTextarea
            aria-label="带货制作要求"
            rows={2}
            value={brief}
            placeholder="例如：突出反差喜剧，保持商品包装与实物一致。"
            onValueChange={onBriefChange}
          />
          <WorkflowFieldHelp>
            补充故事语气、必须展示的动作和不能改的外观，例如“轻喜剧，保留包装字样”；没有额外要求可留空。
          </WorkflowFieldHelp>
        </label>
      </fieldset>
    </details>
  );
}

const FACT_LABELS: Record<CommerceFact["basis"], string> = {
  user: "用户提供",
  source: "来源资料",
  packaging: "商品包装",
  unverified: "待核实",
};
const REVIEW_LABELS = { PASS: "通过", REVISE: "待修订", NEEDS_DECISION: "待确认" } as const;

export function CommerceDeliverables({
  checkpoint,
  onExport,
}: {
  readonly checkpoint: KnowledgeVideoWorkflowCheckpoint;
  readonly onExport?: () => void;
}) {
  const commerce = checkpoint.commerce;
  if (!commerce) return null;
  const stages = ["quick", ...COMMERCE_STAGES] as const;
  if (!stages.some((stage) => commerce.stages[stage]?.artifact) && !commerce.sources?.length)
    return null;
  const assets = checkpoint.film?.assets.length ? checkpoint.film.assets : commerce.sharedAssets;
  return (
    <section
      className="canvas-ai-film-workflow__artifacts canvas-commerce-workflow__artifacts"
      aria-label="带货阶段交付物"
    >
      <strong>{checkpoint.phase === "done" ? "带货交付物已就绪" : "带货制作进展"}</strong>
      {onExport ? (
        <button type="button" onClick={onExport}>
          导出带货制作文档
        </button>
      ) : null}
      {stages.map((stage) => {
        const run = commerce.stages[stage];
        if (!run?.artifact) return null;
        return (
          <details className="canvas-knowledge-workflow__deliverables" key={stage}>
            <summary>
              {COMMERCE_STAGE_LABELS[stage]} · v{run.artifact.version} ·{" "}
              {run.review ? REVIEW_LABELS[run.review.result] : "待检查"}
            </summary>
            <div>
              <small>依据：{run.artifact.inputSummary}</small>
              <MarkdownView content={run.artifact.content} />
              {run.artifact.facts.length ? (
                <details className="canvas-knowledge-workflow__deliverables">
                  <summary>商品事实与依据</summary>
                  <ul className="canvas-commerce-workflow__facts">
                    {run.artifact.facts.map((fact) => (
                      <li key={fact.id}>
                        <span
                          className="canvas-commerce-workflow__fact-label"
                          data-basis={fact.basis}
                        >
                          {FACT_LABELS[fact.basis]}
                        </span>
                        <span>{fact.claim}</span>
                        {fact.sourceUrls.map((url) => (
                          <small key={url}>{url}</small>
                        ))}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {run.review ? (
                <details className="canvas-knowledge-workflow__deliverables">
                  <summary>制作检查 · {REVIEW_LABELS[run.review.result]}</summary>
                  <div>
                    <MarkdownView content={run.review.report} />
                    {run.review.repairInstructions ? (
                      <p>修订要求：{run.review.repairInstructions}</p>
                    ) : null}
                    {run.review.question ? <p>待确认：{run.review.question}</p> : null}
                    {run.review.recommendation ? <p>建议：{run.review.recommendation}</p> : null}
                  </div>
                </details>
              ) : null}
              {run.history.length ? (
                <details className="canvas-knowledge-workflow__deliverables">
                  <summary>历史版本（{run.history.length}）</summary>
                  <div>
                    {run.history.map((artifact) => (
                      <details key={`${artifact.version}-${artifact.createdAt}`}>
                        <summary>v{artifact.version}</summary>
                        <small>依据：{artifact.inputSummary}</small>
                        <MarkdownView content={artifact.content} />
                      </details>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          </details>
        );
      })}
      {commerce.sources?.length ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>资料来源读取记录</summary>
          <ul className="canvas-commerce-workflow__facts">
            {commerce.sources.map((source) => (
              <li key={source.url}>
                <strong>{source.title || source.url}</strong>
                <small>{source.url}</small>
                {source.status === "fetched" ? (
                  <span>已读取</span>
                ) : (
                  <ErrorAlert
                    workflow
                    error={source.error ?? "商品资料页面读取失败，请补充商品文字或文档。"}
                    hint="核对链接是否公开可访问；无法读取时，在商品事实与卖点中补充已确认的文字，或添加本地文档，再继续制作。"
                  />
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {assets.some((asset) => asset.path) ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>商品、角色与场景资产</summary>
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
