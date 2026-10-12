import { useEffect, useId, useRef, useState } from "react";
import { ErrorAlert } from "../../components/ErrorAlert";
import { ImeInput, ImeTextarea } from "../../components/ImeTextField";
import { pickPromptMultimodalFiles, toMediaSrc } from "../../lib/backend";
import { BrandModelLibrary } from "./BrandModelLibrary";
import {
  brandVideoInputSignature,
  brandVideoRequirements,
  type BrandVideoWorkflowOptions,
} from "./brandVideoWorkflowModel";
import { RequiredMark, WorkflowRequirementsHint } from "./workflowFieldRequirements";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import "./BrandVideoWorkflowSections.css";

export interface BrandVideoWorkflowSectionsProps {
  readonly options: BrandVideoWorkflowOptions;
  readonly checkpoint: KnowledgeVideoWorkflowCheckpoint;
  readonly disabled: boolean;
  readonly onChange: (options: BrandVideoWorkflowOptions) => void;
  readonly onBusyChange?: (busy: boolean) => void;
}

export function BrandVideoWorkflowSections({
  options,
  checkpoint,
  disabled,
  onChange,
  onBusyChange,
}: BrandVideoWorkflowSectionsProps) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errorId = useId();
  const operation = useRef(false);
  const latest = useRef(options);
  const mounted = useRef(true);
  useEffect(() => {
    latest.current = options;
  }, [options]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const brand = checkpoint.brandVideo;
  const concept = brand?.concept;
  const stale =
    brand?.inputSignature != null && brand.inputSignature !== brandVideoInputSignature(options);
  const requiredImages = options.deliverable === "video" && options.productFacts.trim().length > 0;

  async function pickProductImages() {
    if (disabled || operation.current) return;
    operation.current = true;
    setPicking(true);
    setError(null);
    onBusyChange?.(true);
    try {
      const picked = await pickPromptMultimodalFiles({
        title: "添加品牌视频商品原图",
        kinds: ["image"],
      });
      if (!mounted.current) return;
      const current = latest.current;
      const existing = new Set(current.productImages.map((image) => image.localPath));
      const next = picked.filter((image) => !existing.has(image.localPath));
      if (next.length) onChange({ ...current, productImages: [...current.productImages, ...next] });
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      operation.current = false;
      if (mounted.current) setPicking(false);
      onBusyChange?.(false);
    }
  }

  return (
    <div className="brand-video-workflow">
      <details className="brand-video-workflow__configuration" aria-label="品牌视频制作设置" open>
        <summary>
          <strong>品牌视频制作设置</strong>
          <span>{options.seriesTitle.trim() || options.occasion}</span>
        </summary>
        <fieldset disabled={disabled || picking} className="brand-video-workflow__fields">
          <legend>
            <RequiredMark>品牌或创意要求</RequiredMark>
          </legend>
          <label>
            <span>品牌名称</span>
            <ImeInput
              aria-label="视频品牌名称"
              value={options.brandName}
              onValueChange={(brandName) => onChange({ ...options, brandName })}
              placeholder="例如：杉间"
            />
          </label>
          <label>
            <span>系列名称</span>
            <ImeInput
              aria-label="视频系列名称"
              value={options.seriesTitle}
              onValueChange={(seriesTitle) => onChange({ ...options, seriesTitle })}
              placeholder="本次新品系列或视觉主题"
            />
          </label>
          <label>
            <span>创意要求</span>
            <ImeTextarea
              aria-label="品牌视频创意要求"
              rows={4}
              value={options.brief}
              onValueChange={(brief) => onChange({ ...options, brief })}
              placeholder="希望传达的感觉、主角、场景、意象和必须出现的画面。品牌名称与创意要求至少填写一项。"
            />
          </label>
          <label>
            <span>商品事实与卖点</span>
            <ImeTextarea
              aria-label="品牌视频商品事实"
              rows={3}
              value={options.productFacts}
              onValueChange={(productFacts) => onChange({ ...options, productFacts })}
              placeholder="只填写已确认的材质、规格、功能和卖点；纯品牌意象片可留空。"
            />
          </label>
          <label>
            <span>视觉风格</span>
            <select
              aria-label="品牌视频视觉风格"
              value={options.style}
              onChange={(event) =>
                onChange({
                  ...options,
                  style: event.target.value as BrandVideoWorkflowOptions["style"],
                })
              }
            >
              <option value="editorial">冷白杂志</option>
              <option value="retro">复古时装</option>
              <option value="quiet">暖白意境</option>
            </select>
          </label>
          <label>
            <span>策划场合</span>
            <ImeInput
              aria-label="品牌视频策划场合"
              value={options.occasion}
              onValueChange={(occasion) => onChange({ ...options, occasion })}
              placeholder="新品系列、节日、品牌概念等"
            />
          </label>
          <div className="brand-video-workflow__format">
            <label>
              <span>目标总时长（秒）</span>
              <input
                aria-label="品牌视频总时长"
                type="number"
                min={1}
                step={1}
                value={options.durationSeconds}
                onChange={(event) =>
                  onChange({ ...options, durationSeconds: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>画幅</span>
              <select
                aria-label="品牌视频画幅"
                value={options.aspectRatio}
                onChange={(event) => onChange({ ...options, aspectRatio: event.target.value })}
              >
                {!["9:16", "16:9", "1:1", "3:4"].includes(options.aspectRatio) ? (
                  <option value={options.aspectRatio}>{options.aspectRatio}</option>
                ) : null}
                <option value="9:16">9:16 竖屏</option>
                <option value="16:9">16:9 横屏</option>
                <option value="1:1">1:1 方形</option>
                <option value="3:4">3:4 竖版</option>
              </select>
            </label>
          </div>
          <label>
            <span>交付方式</span>
            <select
              aria-label="品牌视频交付方式"
              value={options.deliverable}
              onChange={(event) =>
                onChange({
                  ...options,
                  deliverable: event.target.value as BrandVideoWorkflowOptions["deliverable"],
                })
              }
            >
              <option value="video">视频成片与制作文档</option>
              <option value="documents">仅创意与分镜文档</option>
            </select>
          </label>
          <small>
            目标总时长用于编排分镜，逐镜时长按所选视频模型的实际能力匹配。方案完成后先确认首镜，再审核全部片段与成片。
          </small>
          <section className="brand-video-workflow__products" aria-label="品牌视频商品原图">
            <strong>{requiredImages ? <RequiredMark>商品原图</RequiredMark> : "商品原图"}</strong>
            <button
              type="button"
              aria-describedby={error ? errorId : undefined}
              onClick={() => void pickProductImages()}
            >
              {picking ? "正在添加商品原图…" : "添加商品原图"}
            </button>
            <p>
              原图直接作为商品参考。人物参考由下方模特库管理；其他图片、视频和文档可放入工作流的参考素材。
            </p>
            {options.productImages.length ? (
              <ul>
                {options.productImages.map((image) => (
                  <li key={image.localPath}>
                    <img src={toMediaSrc(image.localPath)} alt={`${image.displayName} 商品原图`} />
                    <span title={image.displayName}>{image.displayName}</span>
                    <button
                      type="button"
                      aria-label={`移除品牌商品图：${image.displayName}`}
                      onClick={() =>
                        onChange({
                          ...options,
                          productImages: options.productImages.filter(
                            (item) => item.localPath !== image.localPath,
                          ),
                        })
                      }
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>纯意象品牌片可以不添加商品原图；展示具体商品事实的成片需要本款实物图片。</p>
            )}
          </section>
        </fieldset>
        {error ? (
          <ErrorAlert
            workflow
            id={errorId}
            error={error}
            hint="重新选择可读取的 PNG、JPG 或 WebP 商品图片；资料文档请添加到工作流的参考素材。"
          />
        ) : null}
        <WorkflowRequirementsHint requirements={brandVideoRequirements(options)} />
      </details>
      <BrandModelLibrary
        {...(options.model ? { selected: options.model } : {})}
        brandName={options.brandName}
        disabled={disabled || picking}
        onSelect={(model) => {
          if (model) onChange({ ...options, model });
          else {
            const next = { ...options };
            delete next.model;
            onChange(next);
          }
        }}
        {...(onBusyChange ? { onBusyChange } : {})}
      />
      {concept ? (
        <details className="brand-video-workflow__concept" aria-label="品牌视频创意方案" open>
          <summary>
            <strong>{concept.title}</strong>
            <span>方案 V{brand.version}</span>
          </summary>
          {stale ? (
            <p className="brand-video-workflow__notice" role="status">
              制作设置已改变，下面保留的是上一版方案。重新制作并确认计划后，才会按新设置生成。
            </p>
          ) : null}
          <dl>
            <dt>核心概念</dt>
            <dd>{concept.idea}</dd>
            <dt>视觉方向</dt>
            <dd>{concept.visualDirection}</dd>
            <dt>声音方向</dt>
            <dd>{concept.soundDirection}</dd>
            <dt>品牌文案</dt>
            <dd>{concept.copy}</dd>
          </dl>
          {brand.durationNote ? <p>{brand.durationNote}</p> : null}
          {brand.model ? (
            <p>本方案固定数字模特：{brand.model.name}。后续档案新版本不会替换此方案的参考。</p>
          ) : null}
          <p>
            已编排 {checkpoint.shots.length}{" "}
            个镜头。使用节点的分镜编辑、首镜试产、片段选用和成片确认继续制作。
          </p>
          {brand.sourceImages.length ? (
            <ul className="brand-video-workflow__sources">
              {brand.sourceImages.map((image) => (
                <li key={image.id}>
                  <img src={toMediaSrc(image.path)} alt={`${image.label} 冻结参考`} />
                  <span>
                    {image.label}
                    <small>{image.role === "model" ? "固定模特照片" : "商品原图"}</small>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
