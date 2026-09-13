import { greenScreenPreparationSignature } from "../../lib/greenScreen";
import type { PromptContentDocumentV1 } from "../../lib/promptContent";
import type { OutputNodeData, VideoNodeConfig } from "./workspaceModel";

/** Freeze every user-controlled preparation input so late results cannot be silently reused. */
export function greenScreenWorkflowSignature(
  config: VideoNodeConfig,
  prompt: PromptContentDocumentV1 | undefined,
): string {
  return JSON.stringify({
    preparation: config.greenScreen ? greenScreenPreparationSignature(config.greenScreen) : null,
    model: config.modelSelection,
    parameters: config.parameterValues,
    prompt: prompt ?? null,
  });
}

export function greenScreenPreparationOutputs(
  nodeKey: string,
  config: VideoNodeConfig,
  outputs: readonly OutputNodeData[],
): readonly OutputNodeData[] {
  const tasks = new Set(config.greenScreen?.preparationTasks.map((entry) => entry.taskId));
  return outputs.filter(
    (output) =>
      output.sourceNodeId === nodeKey &&
      tasks.has(output.taskId) &&
      output.mediaType === "video" &&
      output.finalPath != null &&
      output.resultKey != null,
  );
}
