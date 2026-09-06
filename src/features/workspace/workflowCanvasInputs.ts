import type { PromptReferenceInput } from "../../lib/backend";
import type { CanvasDocumentV2 } from "../canvas/canvasStore";
import {
  assetGenerationInput,
  outputGenerationInput,
  type AssetNodeData,
  type OutputNodeData,
  type KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

export interface WorkflowCanvasInput extends PromptReferenceInput {
  readonly edgeId: string;
  readonly previewSrc?: string;
}

export function workflowCanvasInputsFromDocument(
  document: CanvasDocumentV2,
  nodeKey: string,
): readonly WorkflowCanvasInput[] {
  return workflowCanvasInputs(
    document.assetEdges.filter((edge) => edge.toKey === nodeKey),
    new Map(document.assetNodes.map((node) => [node.key, node])),
    new Map((document.outputNodes ?? []).map((node) => [node.key, node])),
  );
}

export function workflowCanvasInputs(
  edges: readonly { readonly id: string; readonly fromKey: string }[],
  assets: ReadonlyMap<string, AssetNodeData>,
  outputs: ReadonlyMap<string, OutputNodeData>,
): readonly WorkflowCanvasInput[] {
  return edges.flatMap((edge): WorkflowCanvasInput[] => {
    const asset = assets.get(edge.fromKey);
    const output = outputs.get(edge.fromKey);
    const input = asset
      ? assetGenerationInput(asset)
      : output
        ? outputGenerationInput(output)
        : null;
    if (!input) return [];
    const previewSrc = input.previewUrl;
    return [
      {
        target: input.target,
        displayName: input.name,
        edgeId: edge.id,
        ...(previewSrc ? { previewSrc } : {}),
      },
    ];
  });
}

/** A run snapshots live edges; detached historical references remain independently removable. */
export function withCanvasWorkflowMaterials(
  node: KnowledgeVideoWorkflowNodeData,
  inputs: readonly WorkflowCanvasInput[],
): KnowledgeVideoWorkflowNodeData {
  if (!inputs.length) return node;
  return {
    ...node,
    config: {
      ...node.config,
      connectedMaterials: [
        ...(node.config.connectedMaterials ?? []),
        ...inputs.map(({ target, displayName }) => ({ target, displayName })),
      ],
    },
  };
}
