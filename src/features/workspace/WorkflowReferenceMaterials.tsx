import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { Paperclip } from "@phosphor-icons/react/Paperclip";
import { X } from "@phosphor-icons/react/X";
import { useState } from "react";

import { AutoSizeThumb } from "./MediaNodeViews";
import {
  formatBytes,
  formatRawBackendError,
  toMediaSrc,
  type PickedPromptMaterial,
  type PromptReferenceInput,
} from "../../lib/backend";
import type { WorkflowCanvasInput } from "./workflowCanvasInputs";
import type { ConnectedCanvasTextInput } from "./canvasInputs";
import type { KnowledgeVideoWorkflowConfig } from "./workspaceModel";
import "./WorkflowReferenceMaterials.css";

const MATERIAL_KIND_LABELS = {
  image: "图片",
  audio: "音频",
  video: "视频",
  document: "文档",
};

interface WorkflowReferenceMaterialsProps {
  readonly materials: readonly PickedPromptMaterial[];
  readonly allMaterials: readonly PickedPromptMaterial[];
  readonly totalCount?: number;
  readonly connectedInputs?: readonly WorkflowCanvasInput[];
  readonly connectedTexts?: readonly ConnectedCanvasTextInput[];
  readonly historicalReferences?: readonly PromptReferenceInput[];
  readonly historicalTexts?: NonNullable<KnowledgeVideoWorkflowConfig["connectedTexts"]>;
  readonly onRemoveHistoricalText?: (key: string) => void;
  readonly onUnlink?: (edgeId: string) => void;
  readonly onRemoveHistoricalReference?: (index: number) => void;
  readonly disabled: boolean;
  readonly picking: boolean;
  readonly onPick?: () => Promise<void>;
  readonly onRemove?: (localPath: string) => void;
}

export function WorkflowReferenceMaterials({
  materials,
  allMaterials,
  totalCount = allMaterials.length,
  connectedInputs = [],
  connectedTexts = [],
  historicalReferences = [],
  historicalTexts = [],
  onRemoveHistoricalText,
  onUnlink,
  onRemoveHistoricalReference,
  disabled,
  picking,
  onPick,
  onRemove,
}: WorkflowReferenceMaterialsProps) {
  const [materialError, setMaterialError] = useState<string | null>(null);
  const totalBytes = allMaterials.reduce((total, material) => total + material.byteSize, 0);

  async function pickMaterials() {
    if (!onPick || disabled || picking) return;
    setMaterialError(null);
    try {
      await onPick();
    } catch (error) {
      setMaterialError(formatRawBackendError(error));
    }
  }

  return (
    <section
      className="canvas-commerce-workflow__materials canvas-workflow-references"
      aria-label="工作流参考素材"
      aria-busy={picking}
    >
      <div className="canvas-commerce-workflow__materials-heading">
        <strong>参考素材（可选）</strong>
        <button
          type="button"
          aria-label="添加工作流多模态参考素材"
          disabled={disabled || picking || !onPick}
          onClick={() => void pickMaterials()}
        >
          {picking ? (
            <CircleNotch size={15} className="spin-icon" aria-hidden="true" />
          ) : (
            <Paperclip size={15} aria-hidden="true" />
          )}
          {picking ? "正在选择素材…" : "添加素材"}
        </button>
      </div>
      <p>图片、音频、视频、PDF、TXT / Markdown、JSON，用于文本模型理解、规划与检查。</p>
      <p>可连接任意画布节点，按连线顺序读取可用媒体和文本，连接数量不限。</p>
      <p className="canvas-workflow-references__quota" aria-live="polite">
        已添加 {materials.length} 项 · 全部参考资料 {totalCount} 项 ·{" "}
        {connectedInputs.length || historicalReferences.length ? "已选本地文件 " : ""}
        {formatBytes(totalBytes) ?? "0 B"}
      </p>
      {allMaterials.length > materials.length ? (
        <p>商品资料、人物参考图与补充素材计入合计。</p>
      ) : null}
      {materials.length ? (
        <ul>
          {materials.map((material) => (
            <li key={material.localPath}>
              <AutoSizeThumb
                previewUrl={material.kind === "image" ? toMediaSrc(material.localPath) : null}
                kind={material.kind}
                height="2.5rem"
                maxWidth="6rem"
              />
              <span>
                <strong title={material.displayName}>{material.displayName}</strong>
                <small>
                  {MATERIAL_KIND_LABELS[material.kind]} · {formatBytes(material.byteSize) ?? "0 B"}
                </small>
              </span>
              <button
                type="button"
                aria-label={`移除工作流参考素材：${material.displayName}`}
                title="移除素材"
                disabled={disabled || picking || !onRemove}
                onClick={() => onRemove?.(material.localPath)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {connectedInputs.length || historicalReferences.length ? (
        <>
          <p>已连接 {connectedInputs.length} 项；连线素材在请求时读取原文件。</p>
          <ul aria-label="工作流连线参考素材">
            {[
              ...connectedInputs.map((input) => ({
                input,
                key: `${input.edgeId}:${input.sourceKey ?? JSON.stringify(input.target)}`,
                label: "已连接",
                action: `断开工作流素材：${input.displayName}`,
                remove: onUnlink ? () => onUnlink(input.edgeId) : undefined,
                previewSrc: input.previewSrc,
              })),
              ...historicalReferences.map((input, index) => ({
                input,
                key: `history-${index}`,
                label: "历史参考素材",
                action: `移除历史参考素材：${input.displayName}`,
                remove: onRemoveHistoricalReference
                  ? () => onRemoveHistoricalReference(index)
                  : undefined,
                previewSrc:
                  input.target.kind === "local_file" ? toMediaSrc(input.target.path) : undefined,
              })),
            ].map(({ input, key, label, action, remove, previewSrc }) => (
              <li key={key}>
                <AutoSizeThumb
                  previewUrl={input.target.mediaType === "image" && previewSrc ? previewSrc : null}
                  kind={input.target.mediaType}
                  height="2.5rem"
                  maxWidth="6rem"
                />
                <span>
                  <strong title={input.displayName}>{input.displayName}</strong>
                  <small>
                    {label} ·{" "}
                    {input.target.mediaType === "image"
                      ? "图片"
                      : input.target.mediaType === "audio"
                        ? "音频"
                        : "视频"}
                  </small>
                </span>
                <button
                  type="button"
                  aria-label={action}
                  title={action}
                  disabled={disabled || picking || !remove}
                  onClick={remove}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {connectedTexts.length || historicalTexts.length ? (
        <ul aria-label="工作流连线文本">
          {connectedTexts.map((input) => (
            <li key={`${input.edgeId}:${input.key}`}>
              <span>
                <strong>{input.name}</strong>
                <small>已连接 · 文本 · {input.text.length} 字符</small>
              </span>
              <button
                type="button"
                aria-label={`断开工作流文本：${input.name}`}
                disabled={disabled || !onUnlink}
                onClick={() => onUnlink?.(input.edgeId)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
          {historicalTexts.map((input) => (
            <li key={`history:${input.key}`}>
              <span>
                <strong>{input.displayName}</strong>
                <small>历史参考文本 · {input.text.length} 字符</small>
              </span>
              <button
                type="button"
                aria-label={`移除历史参考文本：${input.displayName}`}
                disabled={disabled || picking || !onRemoveHistoricalText}
                onClick={() => onRemoveHistoricalText?.(input.key)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {materialError ? <p role="alert">{materialError}</p> : null}
    </section>
  );
}
