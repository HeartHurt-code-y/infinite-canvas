import type { WorkflowHistoryRecord } from "../../lib/workflowHistory";
import { workflowMaterialsSignature } from "./workflowMaterials";
import {
  createKnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, ordered(child)]),
    );
  return value;
}

/** Position and execution progress may change independently of the archived input. */
export function sameWorkflowHistoryInput(
  a: KnowledgeVideoWorkflowNodeData,
  b: KnowledgeVideoWorkflowNodeData,
): boolean {
  const input = (node: KnowledgeVideoWorkflowNodeData) => {
    return ordered({
      ...Object.fromEntries(
        Object.entries(node.config).filter(
          ([key]) =>
            ![
              "checkpoint",
              "historyRunId",
              "catalogResolved",
              "materials",
              "connectedMaterials",
              "connectedTexts",
            ].includes(key),
        ),
      ),
      materialsSignature: workflowMaterialsSignature(node.config),
    });
  };
  return JSON.stringify(input(a)) === JSON.stringify(input(b));
}

/** Restoring a historical run must never overwrite a newer run or edited input on the canvas. */
export function restoreWorkflowHistoryNode(
  record: WorkflowHistoryRecord,
  currentNodes: readonly KnowledgeVideoWorkflowNodeData[],
  options: {
    readonly restart: boolean;
    readonly occupiedKeys: ReadonlySet<string>;
    readonly newKey: string;
    readonly position: { readonly x: number; readonly y: number };
  },
): { readonly node: KnowledgeVideoWorkflowNodeData; readonly replace: boolean } {
  const reusable =
    !options.restart &&
    currentNodes.find(
      (node) =>
        node.config.historyRunId === record.id &&
        sameWorkflowHistoryInput(node, record.nodeSnapshot),
    );
  const key = reusable
    ? reusable.key
    : !options.restart && !options.occupiedKeys.has(record.sourceNodeId)
      ? record.sourceNodeId
      : options.newKey;
  const config = { ...record.nodeSnapshot.config };
  if (options.restart) delete config.historyRunId;
  const checkpoint = options.restart
    ? createKnowledgeVideoWorkflowConfig(
        {
          prompt: config.models.text,
          image: config.models.image,
          video: config.models.video,
        },
        config.catalogResolved,
      ).checkpoint
    : config.checkpoint;
  return {
    replace: !!reusable,
    node: {
      ...record.nodeSnapshot,
      key,
      ...(reusable ? { x: reusable.x, y: reusable.y } : options.position),
      config: {
        ...config,
        ...(!options.restart ? { historyRunId: record.id } : {}),
        checkpoint,
      },
    },
  };
}
