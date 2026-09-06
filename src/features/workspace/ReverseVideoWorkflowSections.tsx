import { useState } from "react";

import { ImeTextarea } from "../../components/ImeTextField";
import { MarkdownView } from "../../components/MarkdownView";
import { formatRawBackendError, toMediaSrc } from "../../lib/backend";
import { revealDesktopItem } from "./desktopActions";
import {
  reverseVideoDeliveryMarkdown,
  type ReverseVideoWorkflowOptions,
} from "./reverseVideoWorkflowModel";
import type { KnowledgeVideoWorkflowCheckpoint } from "./workspaceModel";
import "./ReverseVideoWorkflowSections.css";

interface ReverseVideoConfigurationProps {
  readonly options: ReverseVideoWorkflowOptions;
  readonly brief: string;
  readonly disabled: boolean;
  readonly onChange: (options: ReverseVideoWorkflowOptions) => void;
  readonly onBriefChange: (brief: string) => void;
  readonly onPickVideo?: () => Promise<void> | void;
  readonly onRemoveVideo?: () => void;
  readonly onOpenDownloadSettings?: () => void;
}

export function ReverseVideoConfiguration({
  options,
  brief,
  disabled,
  onChange,
  onBriefChange,
  onPickVideo,
  onRemoveVideo,
  onOpenDownloadSettings,
}: ReverseVideoConfigurationProps) {
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const localSelected = Boolean(options.localVideoPath);

  async function pickVideo() {
    if (!onPickVideo || picking) return;
    setPicking(true);
    setPickError(null);
    try {
      await onPickVideo();
    } catch (error) {
      setPickError(formatRawBackendError(error));
    } finally {
      setPicking(false);
    }
  }

  return (
    <fieldset className="canvas-reverse-video__configuration" disabled={disabled || picking}>
      <legend>要分析的视频</legend>
      {localSelected ? (
        <div className="canvas-reverse-video__local-input">
          <span>
            <strong>{options.localVideoName || "已选择本地视频"}</strong>
            <small>本次直接分析这个文件。移除后可粘贴分享链接。</small>
          </span>
          <button type="button" disabled={!onRemoveVideo} onClick={onRemoveVideo}>
            移除本地视频
          </button>
        </div>
      ) : (
        <label className="canvas-knowledge-workflow__brief">
          <span>分享链接或分享文案</span>
          <ImeTextarea
            aria-label="反推视频分享链接"
            value={options.sourceUrl}
            rows={3}
            placeholder="粘贴一条视频分享链接，可包含分享文案。"
            onValueChange={(sourceUrl) =>
              onChange({ ...options, sourceUrl, localVideoPath: "", localVideoName: "" })
            }
          />
        </label>
      )}
      <div className="canvas-reverse-video__actions">
        <button type="button" disabled={!onPickVideo || picking} onClick={() => void pickVideo()}>
          {picking
            ? "正在选择视频…"
            : localSelected
              ? "更换本地视频"
              : options.sourceUrl.trim()
                ? "改用本地视频"
                : "选择本地视频"}
        </button>
        {!localSelected && options.sourceUrl.trim() && onOpenDownloadSettings ? (
          <button type="button" onClick={onOpenDownloadSettings}>
            导入下载登录凭据
          </button>
        ) : null}
      </div>
      <small>
        {localSelected
          ? "无需下载，使用已选择的视频完成抽帧与分析。"
          : "链接由项目内的下载器处理。若平台要求登录，可导入下载登录凭据后重试。"}
      </small>
      {pickError ? <p role="alert">{pickError}</p> : null}
      <label className="canvas-knowledge-workflow__brief">
        <span>补充方向（可选）</span>
        <ImeTextarea
          aria-label="反推补充方向"
          value={brief}
          rows={2}
          placeholder="例如：重点分析最后几秒的动作，二创改为宠物用品场景。"
          onValueChange={onBriefChange}
        />
      </label>
    </fieldset>
  );
}

interface ReverseVideoDeliverablesProps {
  readonly checkpoint: KnowledgeVideoWorkflowCheckpoint;
}

const REVIEW_LABELS = { PASS: "通过", REVISE: "需要修订", NEEDS_DECISION: "需要确认" } as const;

export function ReverseVideoDeliverables({ checkpoint }: ReverseVideoDeliverablesProps) {
  const [openError, setOpenError] = useState<string | null>(null);
  const state = checkpoint.reverseVideo;
  if (!state) return null;
  const { evidence, analysis, review, learning, delivery } = state;
  const videoPath = delivery?.videoPath ?? state.videoPath;
  if (!videoPath && !evidence && !analysis && !delivery) return null;

  async function reveal(path: string) {
    setOpenError(null);
    try {
      await revealDesktopItem(path);
    } catch (error) {
      setOpenError(formatRawBackendError(error));
    }
  }

  return (
    <section className="canvas-reverse-video__deliverables" aria-label="短视频反推交付物">
      <strong>{checkpoint.phase === "done" ? "反推交付物已就绪" : "已完成的分析与素材"}</strong>
      {videoPath ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>原片预览</summary>
          <div>
            <video
              aria-label="反推原片预览"
              controls
              preload="metadata"
              src={toMediaSrc(videoPath)}
            />
            <button type="button" onClick={() => void reveal(videoPath)}>
              查看原片文件
            </button>
          </div>
        </details>
      ) : null}
      {evidence ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>
            抽帧联系表 · 全片 {evidence.overviewFrameCount} 帧 / 尾部 {evidence.tailFrameCount} 帧
          </summary>
          <div>
            <p>
              原片 {evidence.duration.toFixed(2)} 秒 · {evidence.width} × {evidence.height}。
              联系表保留每帧时间戳，尾部动作单独加密采样。
            </p>
            <div className="canvas-reverse-video__sheets">
              {evidence.representativeFrames?.map((frame) => (
                <figure key={frame.localPath}>
                  <img src={toMediaSrc(frame.localPath)} alt={frame.displayName} loading="lazy" />
                  <figcaption>
                    {frame.displayName} · {frame.time.toFixed(2)} 秒
                  </figcaption>
                </figure>
              ))}
              {evidence.sheets.map((sheet) => (
                <figure key={sheet.localPath}>
                  <img src={toMediaSrc(sheet.localPath)} alt={sheet.displayName} loading="lazy" />
                  <figcaption>
                    {sheet.displayName}
                    {sheet.firstTime != null && sheet.lastTime != null
                      ? ` · ${sheet.firstTime.toFixed(2)}—${sheet.lastTime.toFixed(2)} 秒`
                      : ""}
                    {sheet.frameCount != null ? ` · ${sheet.frameCount} 帧` : ""}
                  </figcaption>
                  <button type="button" onClick={() => void reveal(sheet.localPath)}>
                    查看{sheet.displayName}文件
                  </button>
                </figure>
              ))}
            </div>
          </div>
        </details>
      ) : null}
      {analysis ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>反推提示词与二创路线</summary>
          <div>
            <MarkdownView content={reverseVideoDeliveryMarkdown(checkpoint)} />
          </div>
        </details>
      ) : null}
      {review ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>分析检查 · {REVIEW_LABELS[review.result]}</summary>
          <div>
            <MarkdownView content={review.report} />
            {review.repairInstructions ? <p>修订要求：{review.repairInstructions}</p> : null}
            {review.question ? <p>待确认：{review.question}</p> : null}
          </div>
        </details>
      ) : null}
      {delivery ? (
        <div className="canvas-reverse-video__archive" role="status">
          <strong>案例已入库</strong>
          <span>本次入库后共 {delivery.caseCount} 条案例，可供后续反推学习参考。</span>
        </div>
      ) : learning ? (
        <p>本次已参考案例库中的 {learning.caseCount} 条案例，完成校验后保存本次案例。</p>
      ) : null}
      {learning?.summary ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>本次学习参考 · {learning.caseCount} 条案例</summary>
          <div>
            <MarkdownView content={learning.summary} />
          </div>
        </details>
      ) : null}
      {delivery ? (
        <div className="canvas-reverse-video__actions">
          <button type="button" onClick={() => void reveal(delivery.markdownPath)}>
            查看 Markdown 文件
          </button>
          <button type="button" onClick={() => void reveal(delivery.textPath)}>
            查看 TXT 文件
          </button>
          <button type="button" onClick={() => void reveal(delivery.casePath)}>
            查看案例文件
          </button>
          <button type="button" onClick={() => void reveal(delivery.directory)}>
            查看交付文件夹
          </button>
        </div>
      ) : null}
      {state.history.length ? (
        <details className="canvas-knowledge-workflow__deliverables">
          <summary>修订前的分析（{state.history.length}）</summary>
          <div>
            {state.history.map((version, index) => (
              <details key={index}>
                <summary>
                  版本 {index + 1} · {version.analysis.title}
                </summary>
                <pre>{version.analysis.replicationPrompt}</pre>
                {version.review ? <MarkdownView content={version.review.report} /> : null}
              </details>
            ))}
          </div>
        </details>
      ) : null}
      {openError ? <p role="alert">{openError}</p> : null}
    </section>
  );
}
