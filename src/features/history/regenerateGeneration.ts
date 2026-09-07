import type {
  ExplicitMediaInput,
  GenerationOperation,
  GenerationTaskDetail,
  StartGenerationCommand,
} from "../../lib/backend";

/** 可重新生成的媒体操作；提示词优化（text_generation）走节点自身的重跑流程。 */
export function isRegenerableOperation(operation: string): operation is GenerationOperation {
  return (
    operation === "text_to_image" ||
    operation === "image_to_image" ||
    operation === "video_generation"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/**
 * 从生成任务详情中还原冻结的 StartGenerationCommand。
 * 只保留重跑必需的字段：去除 workflowRunId（重新生成是独立运行，不续接原工作流运行），
 * 省略 modelOperationSchemaSnapshot（后端会在 start 时按当前模型定义重新写入）。
 * 快照不完整时返回 null，调用方据此禁用重新生成入口。
 */
export function frozenStartCommand(detail: GenerationTaskDetail): StartGenerationCommand | null {
  const request = detail.logicalRequest;
  if (!isRecord(request)) return null;
  const {
    canvasId,
    sourceNodeId,
    operation,
    providerConnectionId,
    modelDefinitionId,
    prompt,
    explicitMedia,
    parameters,
    generationCount,
  } = request;
  if (
    typeof canvasId !== "string" ||
    canvasId === "" ||
    typeof sourceNodeId !== "string" ||
    sourceNodeId === "" ||
    typeof operation !== "string" ||
    !isRegenerableOperation(operation) ||
    typeof providerConnectionId !== "string" ||
    providerConnectionId === "" ||
    typeof modelDefinitionId !== "string" ||
    modelDefinitionId === "" ||
    !Array.isArray(prompt)
  ) {
    return null;
  }
  return {
    canvasId,
    sourceNodeId,
    operation,
    providerConnectionId,
    modelDefinitionId,
    prompt,
    ...(Array.isArray(explicitMedia) && explicitMedia.length > 0
      ? { explicitMedia: explicitMedia as readonly ExplicitMediaInput[] }
      : {}),
    ...(isRecord(parameters) && Object.keys(parameters).length > 0
      ? { parameters }
      : {}),
    ...(typeof generationCount === "number" &&
    Number.isInteger(generationCount) &&
    generationCount >= 1
      ? { generationCount }
      : {}),
  };
}
