import type { PromptReferenceInput } from "../../lib/backend";
import type { CanvasDocumentV2 } from "../canvas/canvasStore";
import {
  createCanvasInputResolver,
  canvasNodesByKeyFromDocument,
  type ConnectedCanvasTextInput,
  type ResolvedCanvasInputs,
} from "./canvasInputs";
import { workflowConnectedTextBlock } from "./workflowMaterials";
import type { KnowledgeVideoWorkflowNodeData } from "./workspaceModel";

export interface WorkflowCanvasInput extends PromptReferenceInput {
  readonly edgeId: string;
  readonly sourceKey?: string;
  readonly previewSrc?: string;
}

export interface WorkflowCanvasInputs {
  readonly media: readonly WorkflowCanvasInput[];
  readonly texts: readonly ConnectedCanvasTextInput[];
}

export function workflowCanvasInputsFromResolved(
  inputs: ResolvedCanvasInputs,
): WorkflowCanvasInputs {
  return {
    media: inputs.media.map(({ target, name, edgeId, sourceKey, previewUrl }) => ({
      target,
      displayName: name,
      edgeId,
      sourceKey,
      ...(previewUrl ? { previewSrc: previewUrl } : {}),
    })),
    texts: inputs.texts,
  };
}

export function workflowCanvasInputsFromDocument(
  document: CanvasDocumentV2,
  nodeKey: string,
): WorkflowCanvasInputs {
  const resolve = createCanvasInputResolver(
    canvasNodesByKeyFromDocument(document),
    document.assetEdges,
  );
  return workflowCanvasInputsFromResolved(resolve(nodeKey));
}

/** A run snapshots live edges; detached historical references remain independently removable. */
export function withCanvasWorkflowMaterials(
  node: KnowledgeVideoWorkflowNodeData,
  inputs: WorkflowCanvasInputs | readonly WorkflowCanvasInput[],
): KnowledgeVideoWorkflowNodeData {
  const bundle: WorkflowCanvasInputs = "media" in inputs ? inputs : { media: inputs, texts: [] };
  if (!bundle.media.length && !bundle.texts.length) return node;
  const texts = new Map((node.config.connectedTexts ?? []).map((input) => [input.key, input]));
  for (const { key, sourceKey, name, text } of bundle.texts)
    texts.set(key, { key, sourceKey, displayName: name, text });
  const previousTextBlock = workflowConnectedTextBlock(node.config);
  const originalBrief =
    previousTextBlock && node.config.brief.endsWith(previousTextBlock)
      ? node.config.brief.slice(0, -previousTextBlock.length).trimEnd()
      : node.config.brief;
  const config = {
    ...node.config,
    connectedMaterials: [
      ...(node.config.connectedMaterials ?? []),
      ...bundle.media.map(({ target, displayName }) => ({ target, displayName })),
    ],
    ...(texts.size ? { connectedTexts: [...texts.values()] } : {}),
  };
  const textBlock = workflowConnectedTextBlock(config);
  return {
    ...node,
    config: { ...config, brief: [originalBrief, textBlock].filter(Boolean).join("\n\n") },
  };
}

/** Matching history restores progress; the current canvas retains ownership of editable inputs. */
export function withLiveWorkflowCanvasInputs(
  restored: KnowledgeVideoWorkflowNodeData,
  current: KnowledgeVideoWorkflowNodeData | undefined,
): KnowledgeVideoWorkflowNodeData {
  if (!current) return restored;
  return {
    ...restored,
    config: {
      ...restored.config,
      brief: current.config.brief,
      connectedMaterials: current.config.connectedMaterials ?? [],
      connectedTexts: current.config.connectedTexts ?? [],
    },
  };
}
