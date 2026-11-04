import type { GenerationResultRecord, GenerationTaskSummary } from "../../lib/backend";
import type { GenNodeData, OutputNodeData } from "./workspaceModel";

export interface ImageNodeResult {
  readonly taskId: string;
  readonly resultKey: string;
  readonly resultIndex: number;
  readonly finalPath: string | null;
  /** 临时预览只在会话内使用，画布快照会移除它。 */
  readonly previewSrc?: string | null;
  readonly name: string | null;
}

export interface ImageNodeGeneration {
  readonly taskIds: readonly string[];
  readonly results: readonly ImageNodeResult[];
  readonly selectedResultKey?: string;
  readonly expectedResults?: Readonly<Record<string, number>>;
}

/** Restore saved artifacts without subscribing the node to old task events again. */
export function restoreImageNodeGeneration(
  taskId: string,
  records: readonly GenerationResultRecord[],
  selectedResultIndex: number,
): ImageNodeGeneration {
  const results = [...new Map(records.filter(record => record.taskId === taskId &&
    record.mediaType === "image" && record.saveStatus === "succeeded" && record.finalPath &&
    Number.isInteger(record.resultIndex) && record.resultIndex >= 0).map(record => {
    const result: ImageNodeResult = {
      taskId, resultKey: `${taskId}#${record.resultIndex}`, resultIndex: record.resultIndex,
      finalPath: record.finalPath, name: record.displayName ?? null,
    };
    return [result.resultKey, result] as const;
  })).values()].sort((a, b) => a.resultIndex - b.resultIndex);
  const selectedResultKey = `${taskId}#${selectedResultIndex}`;
  if (!results.some(result => result.resultKey === selectedResultKey))
    throw new Error("该图片尚未保存，无法恢复到画布。");
  return { taskIds: [], results, selectedResultKey };
}

type ImageNode = Extract<GenNodeData, { kind: "image" }>;

export interface ImageGenerationSlot {
  readonly key: string;
  readonly result: ImageNodeResult | null;
  readonly task: GenerationTaskSummary | null;
}

export function imageGenerationSlots(node: ImageNode, tasks: readonly GenerationTaskSummary[]): readonly ImageGenerationSlot[] {
  const generation = node.imageGeneration;
  if (!generation) return [];
  const results = new Map(generation.results.map(result => [result.resultKey, result]));
  const byTask = new Map(tasks.map(task => [task.id, task]));
  const taskIds = [...new Set([...generation.taskIds, ...generation.results.map(result => result.taskId)])];
  return taskIds.flatMap(taskId => {
    const ready = generation.results.filter(result => result.taskId === taskId);
    const count = Math.max(ready.length, generation.expectedResults?.[taskId] ?? 1);
    const keys = new Set(ready.map(result => result.resultKey));
    // Result indices are one-based in live submissions. Restored older results
    // keep their original identity, including index zero.
    for (let index = 1; keys.size < count; index += 1) keys.add(`${taskId}#${index}`);
    return [...keys].sort((a, b) => Number(a.slice(a.lastIndexOf("#") + 1)) - Number(b.slice(b.lastIndexOf("#") + 1)))
      .map(key => ({ key, result: results.get(key) ?? null, task: byTask.get(taskId) ?? null }));
  });
}

export function selectedImageResult(node: ImageNode): ImageNodeResult | null {
  const generation = node.imageGeneration;
  const results = generation?.results.filter(result => result.finalPath || result.previewSrc) ?? [];
  return results.find(result => result.resultKey === generation?.selectedResultKey)
    ?? results[0] ?? null;
}

/** 复用媒体预览/导出的数据契约，不创建画布节点或连线。 */
export function imageNodePreview(node: ImageNode): OutputNodeData | null {
  const result = selectedImageResult(node);
  return result ? {
    ...result, key: node.key, sourceNodeId: node.key, mediaType: "image",
    origin: "generation", name: node.name ?? result.name, x: node.x, y: node.y,
  } : null;
}

export function imageResultFromOutput(output: OutputNodeData): ImageNodeResult | null {
  if (output.mediaType !== "image" || !output.resultKey?.startsWith(`${output.taskId}#`) || (!output.finalPath && !output.previewSrc)) return null;
  const resultIndex = Number(output.resultKey.slice(`${output.taskId}#`.length));
  if (!Number.isInteger(resultIndex) || resultIndex < 1) return null;
  return {
    taskId: output.taskId, resultKey: output.resultKey, resultIndex,
    finalPath: output.finalPath, previewSrc: output.previewSrc ?? null, name: output.name,
  };
}

/** 只接受当前批次；旧任务的迟到事件仍写历史，不能覆盖当前节点。 */
export function applyImageNodeResult(
  node: ImageNode,
  record: GenerationResultRecord,
  previewSrc: string | null,
): ImageNode {
  const generation = node.imageGeneration;
  if (record.mediaType !== "image" || !generation?.taskIds.includes(record.taskId)) return node;
  const saved = record.saveStatus === "succeeded" && record.finalPath != null;
  if (!saved && !previewSrc) return node;
  const resultKey = `${record.taskId}#${record.resultIndex}`;
  const results = generation.results.filter(result => generation.taskIds.includes(result.taskId));
  const previous = results.find(result => result.resultKey === resultKey);
  // 保存事件可能先于预览事件抵达，不能把已落盘的结果退回临时 URL。
  if (previous?.finalPath && !saved) return node;
  const result: ImageNodeResult = {
    taskId: record.taskId, resultKey, resultIndex: record.resultIndex,
    finalPath: saved ? record.finalPath : null,
    previewSrc: saved ? null : previewSrc,
    name: record.displayName ?? previous?.name ?? null,
  };
  if (previous?.finalPath === result.finalPath && previous?.previewSrc === result.previewSrc) return node;
  const nextResults = [...results.filter(entry => entry.resultKey !== resultKey), result].sort((a, b) =>
    generation.taskIds.indexOf(a.taskId) - generation.taskIds.indexOf(b.taskId) || a.resultIndex - b.resultIndex,
  );
  const selected = nextResults.some(entry => entry.resultKey === generation.selectedResultKey)
    ? generation.selectedResultKey : nextResults[0]?.resultKey;
  return {
    ...node,
    imageGeneration: {
      ...generation,
      taskIds: generation.taskIds, results: nextResults,
      ...(selected ? { selectedResultKey: selected } : {}),
    },
  };
}
