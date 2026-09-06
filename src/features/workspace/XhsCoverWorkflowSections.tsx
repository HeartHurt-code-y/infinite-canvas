import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { useState } from "react";

import { ImeInput } from "../../components/ImeTextField";
import { MarkdownView } from "../../components/MarkdownView";
import { formatRawBackendError, isDesktopRuntime, toMediaSrc } from "../../lib/backend";
import { copyTextToDesktopClipboard } from "./desktopActions";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import {
  XHS_COVER_STYLES,
  XHS_COVER_MAX_REFERENCE_BYTES,
  type XhsCoverWorkflowOptions,
} from "./xhsCoverWorkflowModel";

type ImageRole = "portrait" | "material";

interface XhsCoverConfigurationProps {
  readonly options: XhsCoverWorkflowOptions;
  readonly disabled: boolean;
  readonly onChange: (options: XhsCoverWorkflowOptions) => void;
  readonly onPickImages?: (role: ImageRole) => Promise<void>;
  readonly onRemoveImage?: (role: ImageRole, path: string) => void;
}

const EXPRESSIONS = {
  auto: "根据内容自动选择",
  surprised: "张嘴震惊",
  thumbs_up: "双手点赞",
  pointing: "指向标题",
  thoughtful: "托腮疑惑",
  confident: "举拳自信",
  explaining: "双手打开讲解",
};
const BACKGROUNDS = {
  auto: "根据内容自动选择",
  warm: "室内暖光背景",
  tech: "黑灰科技海报背景",
  tool_wall: "深色工具墙背景",
  interface: "模糊软件界面背景",
  contrast: "高饱和撞色背景",
};
const FONTS = {
  auto: "根据内容自动选择",
  bold: "综艺超粗黑体",
  comic: "漫画标题字",
  rounded: "圆润粗黑体",
  tech: "科技感粗黑体",
  handwritten: "粗标题 + 手写涂鸦小字",
};
const COLORS = {
  yellow: "柔和浅黄 #FDFFA7 + 粗黑描边",
  white: "纯白 + 粗黑描边",
  mixed: "浅黄 / 白色混排 + 粗黑描边",
  highlight: "浅黄 + 白色高光 + 粗黑描边",
  dark: "深底白字 + 浅黄关键词",
};

export function XhsCoverConfiguration({
  options,
  disabled,
  onChange,
  onPickImages,
  onRemoveImage,
}: XhsCoverConfigurationProps) {
  const [picking, setPicking] = useState<ImageRole | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const images = [...options.portraits, ...options.materials];
  const totalBytes = images.reduce((total, item) => total + item.byteSize, 0);
  const full = images.length >= 8;

  async function pickImages(role: ImageRole) {
    if (!onPickImages) return;
    setPicking(role);
    setImageError(null);
    try {
      await onPickImages(role);
    } catch (error) {
      setImageError(formatRawBackendError(error));
    } finally {
      setPicking(null);
    }
  }

  return (
    <fieldset disabled={disabled} className="canvas-xhs-cover__configuration">
      {(["portrait", "material"] as const).map((role) => {
        const portraits = role === "portrait";
        const items = portraits ? options.portraits : options.materials;
        const title = portraits ? "人物参考图" : "补充素材";
        return (
          <section
            className="canvas-xhs-cover__references canvas-commerce-workflow__materials"
            aria-label={title}
            key={role}
          >
            <div className="canvas-commerce-workflow__materials-heading">
              <strong>
                {title}
                {portraits ? "（必填）" : "（可选）"}
              </strong>
              <button
                type="button"
                disabled={
                  !onPickImages || picking !== null || full || items.length >= (portraits ? 3 : 5)
                }
                onClick={() => void pickImages(role)}
              >
                {picking === role ? "正在选择图片…" : `添加${title}`}
              </button>
            </div>
            <small>
              {portraits
                ? "上传 1–3 张同一人物照片。不露脸时，请提供手部、半脸或侧脸等局部参考。"
                : "可添加最多 5 张产品图、截图或图标；没有素材时，自动设计相关装饰。"}
            </small>
            {items.length ? (
              <ul>
                {items.map((item) => (
                  <li key={item.localPath}>
                    <img src={toMediaSrc(item.localPath)} alt={item.displayName} loading="lazy" />
                    <span>
                      {item.displayName}
                      <small>{(item.byteSize / 1024 / 1024).toFixed(2)} MB</small>
                    </span>
                    <button
                      type="button"
                      disabled={!onRemoveImage}
                      aria-label={`移除${title} ${item.displayName}`}
                      onClick={() => onRemoveImage?.(role, item.localPath)}
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            ) : portraits ? (
              <p>请添加人物参考图后开始制作，人物身份将沿用参考图。</p>
            ) : null}
          </section>
        );
      })}
      <small>
        图片合计最多 8 张、8 MB。当前 {images.length} 张 · {(totalBytes / 1024 / 1024).toFixed(2)}{" "}
        MB。
      </small>
      {totalBytes > XHS_COVER_MAX_REFERENCE_BYTES || images.length > 8 ? (
        <p role="alert">图片超过数量或大小限制，请移除部分图片后继续。</p>
      ) : null}
      {imageError ? <p role="alert">{imageError}</p> : null}
      <details className="canvas-knowledge-workflow__models canvas-xhs-cover__preferences">
        <summary>
          <span className="canvas-knowledge-workflow__models-title">封面偏好</span>
          <span>
            {options.style === "auto" ? "自动匹配风格" : XHS_COVER_STYLES[options.style]} · 3:4 竖版
          </span>
          <CaretDown size={15} aria-hidden="true" />
        </summary>
        <div className="canvas-xhs-cover__settings">
          <label className="canvas-xhs-cover__title">
            指定标题（可选）
            <ImeInput
              aria-label="封面标题"
              value={options.title}
              placeholder="留空自动生成 3 个候选标题并择优"
              onValueChange={(title) => onChange({ ...options, title })}
            />
          </label>
          <label>
            封面风格
            <select
              aria-label="封面风格"
              value={options.style}
              onChange={(event) =>
                onChange({
                  ...options,
                  style: event.target.value as XhsCoverWorkflowOptions["style"],
                })
              }
            >
              <option value="auto">根据内容自动匹配</option>
              {Object.entries(XHS_COVER_STYLES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {(
            [
              ["expression", "人物表情与动作", EXPRESSIONS],
              ["background", "背景色调", BACKGROUNDS],
              ["font", "字体风格", FONTS],
              ["color", "标题颜色", COLORS],
            ] as const
          ).map(([field, label, choices]) => (
            <label key={field}>
              {label}
              <select
                aria-label={`封面${label}`}
                value={options[field]}
                onChange={(event) => onChange({ ...options, [field]: event.target.value })}
              >
                {Object.entries(choices).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label>
            交付方式
            <select
              aria-label="封面交付方式"
              value={options.deliverable}
              onChange={(event) =>
                onChange({
                  ...options,
                  deliverable: event.target.value as XhsCoverWorkflowOptions["deliverable"],
                })
              }
            >
              <option value="image">生成封面图片与制作文档</option>
              <option value="prompt">仅生成提示词与制作文档</option>
            </select>
          </label>
          <small className="canvas-xhs-cover__title">
            自动提炼标题、编排画面并检查；关键内容需要你决定时才暂停。
          </small>
        </div>
      </details>
    </fieldset>
  );
}

interface XhsCoverDeliverablesProps {
  readonly checkpoint: KnowledgeVideoWorkflowCheckpoint;
  readonly onRevealResult?: () => void;
  readonly onExportDocuments?: () => void;
}

const REVIEW_LABELS = { PASS: "通过", REVISE: "需要修订", NEEDS_DECISION: "需要确认" } as const;

export function XhsCoverDeliverables({
  checkpoint,
  onRevealResult,
  onExportDocuments,
}: XhsCoverDeliverablesProps) {
  const [copyMessage, setCopyMessage] = useState("");
  const state = checkpoint.xhsCover;
  if (!state?.plan) return null;
  const { plan, review, history } = state;
  const imagePath = state.finalPath ?? state.imagePath;

  async function copyPrompt() {
    try {
      if (isDesktopRuntime()) await copyTextToDesktopClipboard(plan.prompt);
      else if (navigator.clipboard) await navigator.clipboard.writeText(plan.prompt);
      else throw new Error("当前环境不支持复制，请从下方选中提示词手动复制。");
      setCopyMessage("提示词已复制");
    } catch (error) {
      setCopyMessage(`复制失败：${formatRawBackendError(error)}`);
    }
  }

  return (
    <section className="canvas-xhs-cover__deliverables" aria-label="封面交付物">
      <strong>{checkpoint.phase === "done" ? "封面交付物已就绪" : "封面制作进展"}</strong>
      {imagePath ? (
        <figure className="canvas-xhs-cover__preview">
          <img src={toMediaSrc(imagePath)} alt={`封面：${plan.title}`} />
          <figcaption>{plan.title} · 3:4 竖版</figcaption>
        </figure>
      ) : null}
      <div className="canvas-xhs-cover__actions">
        {imagePath && onRevealResult ? (
          <button type="button" onClick={onRevealResult}>
            打开封面文件
          </button>
        ) : null}
        {onExportDocuments ? (
          <button type="button" onClick={onExportDocuments}>
            导出封面制作文档
          </button>
        ) : null}
      </div>
      <details className="canvas-knowledge-workflow__deliverables" open={!imagePath}>
        <summary>封面方案 · {XHS_COVER_STYLES[plan.style]}</summary>
        <div>
          <strong>{plan.title}</strong>
          {plan.subtitle ? <p>{plan.subtitle}</p> : null}
          <p>{plan.rationale}</p>
          {plan.titleCandidates.length ? (
            <details>
              <summary>候选标题与自动选择</summary>
              <ol>
                {plan.titleCandidates.map((title, index) => (
                  <li key={`${index}-${title}`}>
                    {title}
                    {title === plan.title ? "（已选）" : ""}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          <details className="canvas-knowledge-workflow__deliverables">
            <summary>完整图片提示词</summary>
            <div>
              <button type="button" onClick={() => void copyPrompt()}>
                复制封面提示词
              </button>
              <span role="status">{copyMessage}</span>
              <pre className="canvas-xhs-cover__prompt">{plan.prompt}</pre>
            </div>
          </details>
        </div>
      </details>
      {review ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>封面检查 · {REVIEW_LABELS[review.result]}</summary>
          <div>
            <MarkdownView content={review.report} />
            {review.repairInstructions ? <p>修订要求：{review.repairInstructions}</p> : null}
            {review.question ? <p>待确认：{review.question}</p> : null}
          </div>
        </details>
      ) : null}
      {history.length ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>历史版本（{history.length}）</summary>
          <div>
            {history.map((version, index) => (
              <details key={index}>
                <summary>
                  版本 {index + 1} · {version.plan.title}
                </summary>
                {version.finalPath || version.imagePath ? (
                  <img
                    className="canvas-xhs-cover__history-image"
                    src={toMediaSrc((version.finalPath ?? version.imagePath)!)}
                    alt={`历史封面 ${index + 1}：${version.plan.title}`}
                    loading="lazy"
                  />
                ) : null}
                <pre className="canvas-xhs-cover__prompt">{version.plan.prompt}</pre>
                {version.review ? <MarkdownView content={version.review.report} /> : null}
              </details>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
