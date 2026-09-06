import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { FileText } from "@phosphor-icons/react/FileText";
import { MusicNotes } from "@phosphor-icons/react/MusicNotes";
import { Paperclip } from "@phosphor-icons/react/Paperclip";
import { VideoCamera } from "@phosphor-icons/react/VideoCamera";
import { X } from "@phosphor-icons/react/X";
import { useState } from "react";

import {
  formatBytes,
  formatRawBackendError,
  toMediaSrc,
  type PickedPromptMaterial,
  type PromptReferenceInput,
} from "../../lib/backend";
import type { WorkflowCanvasInput } from "./workflowCanvasInputs";
import {
  MAX_WORKFLOW_MATERIAL_BYTES,
  MAX_WORKFLOW_MATERIALS,
  workflowMaterialPathKey,
} from "./workflowMaterials";
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
  readonly historicalReferences?: readonly PromptReferenceInput[];
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
  historicalReferences = [],
  onUnlink,
  onRemoveHistoricalReference,
  disabled,
  picking,
  onPick,
  onRemove,
}: WorkflowReferenceMaterialsProps) {
  const [materialError, setMaterialError] = useState<string | null>(null);
  const totalBytes = allMaterials.reduce((total, material) => total + material.byteSize, 0);
  const atCapacity =
    totalCount >= MAX_WORKFLOW_MATERIALS || totalBytes >= MAX_WORKFLOW_MATERIAL_BYTES;
  const overLimit = totalCount > MAX_WORKFLOW_MATERIALS || totalBytes > MAX_WORKFLOW_MATERIAL_BYTES;
  const generalPaths = new Set(materials.map(workflowMaterialPathKey));
  const canReuseSpecialized =
    allMaterials.some((material) => !generalPaths.has(workflowMaterialPathKey(material))) ||
    [...connectedInputs, ...historicalReferences].some(
      ({ target }) =>
        target.kind === "local_file" &&
        !generalPaths.has(target.path.trim().replaceAll("/", "\\").toLowerCase()),
    );
  const full = overLimit || (atCapacity && !canReuseSpecialized);

  async function pickMaterials() {
    if (!onPick || disabled || picking || full) return;
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
          disabled={disabled || picking || !onPick || full}
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
      <p>可将画布上的图片、音频或视频素材连接到本节点左侧端口。</p>
      <p className="canvas-workflow-references__quota" aria-live="polite">
        已添加 {materials.length} 项 · 全部参考资料 {totalCount} / {MAX_WORKFLOW_MATERIALS} 项 ·{" "}
        {connectedInputs.length || historicalReferences.length ? "已选本地文件 " : ""}
        {formatBytes(totalBytes) ?? "0 B"} / 14 MB
      </p>
      {allMaterials.length > materials.length ? (
        <p>商品资料、人物参考图与补充素材计入合计。</p>
      ) : null}
      {atCapacity && canReuseSpecialized && !overLimit ? (
        <p>可选择已有专用资料作为参考；添加新文件前请先移除部分素材。</p>
      ) : null}
      {materials.length ? (
        <ul>
          {materials.map((material) => (
            <li key={material.localPath}>
              {material.kind === "image" ? (
                <img
                  src={toMediaSrc(material.localPath)}
                  alt={material.displayName}
                  loading="lazy"
                />
              ) : (
                <span className="canvas-workflow-references__icon" aria-hidden="true">
                  {material.kind === "audio" ? (
                    <MusicNotes size={20} />
                  ) : material.kind === "video" ? (
                    <VideoCamera size={20} />
                  ) : (
                    <FileText size={20} />
                  )}
                </span>
              )}
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
          <p>已连接 {connectedInputs.length} 项；连线素材在请求时读取原文件并校验合计大小。</p>
          <ul aria-label="工作流连线参考素材">
            {[
              ...connectedInputs.map((input) => ({
                input,
                key: input.edgeId,
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
                {input.target.mediaType === "image" && previewSrc ? (
                  <img src={previewSrc} alt={input.displayName} loading="lazy" />
                ) : (
                  <span className="canvas-workflow-references__icon" aria-hidden="true">
                    {input.target.mediaType === "audio" ? (
                      <MusicNotes size={20} />
                    ) : input.target.mediaType === "video" ? (
                      <VideoCamera size={20} />
                    ) : (
                      <Paperclip size={20} />
                    )}
                  </span>
                )}
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
      {overLimit ? <p role="alert">参考资料合计超过 8 项或 14 MB，请移除部分素材后继续。</p> : null}
      {materialError ? <p role="alert">{materialError}</p> : null}
    </section>
  );
}
