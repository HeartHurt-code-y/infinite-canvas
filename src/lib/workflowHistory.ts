import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";
import { isDesktopRuntime, type GenerationTaskSummary } from "./backend";
import type {
  KnowledgeVideoWorkflowNodeData,
  KnowledgeVideoWorkflowPhase,
} from "../features/workspace/workspaceModel";

export type WorkflowHistoryKind =
  "knowledge" | "film" | "comicDrama" | "commerce" | "remotion" | "xhsCover" | "reverseVideo";

export interface WorkflowHistoryModelSnapshot {
  readonly role: "text" | "image" | "video";
  readonly providerId: string;
  readonly providerName: string;
  readonly modelDefinitionId: string;
  readonly modelName: string;
}

export interface WorkflowHistoryRecord {
  readonly id: string;
  readonly canvasId: string;
  readonly sourceNodeId: string;
  readonly workflowKind: WorkflowHistoryKind;
  readonly title: string;
  readonly status: KnowledgeVideoWorkflowPhase;
  readonly progress: number;
  readonly message: string;
  readonly error: string | null;
  readonly nodeSnapshot: KnowledgeVideoWorkflowNodeData;
  readonly models: readonly WorkflowHistoryModelSnapshot[];
  readonly attemptCount: number;
  /** Save uses the last server revision; a newly created run starts at zero. */
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkflowHistoryEvent {
  readonly id: string;
  readonly phase: KnowledgeVideoWorkflowPhase;
  readonly progress: number;
  readonly message: string;
  readonly error: string | null;
  readonly createdAt: number;
}

export interface WorkflowHistoryDetail {
  readonly record: WorkflowHistoryRecord;
  readonly events: readonly WorkflowHistoryEvent[];
  readonly tasks: readonly GenerationTaskSummary[];
}

export interface WorkflowHistoryQuery {
  readonly canvasId?: string;
  readonly sourceNodeId?: string;
  readonly statuses?: readonly KnowledgeVideoWorkflowPhase[];
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface WorkflowHistoryPage {
  readonly items: readonly WorkflowHistoryRecord[];
  readonly nextCursor: string | null;
}

export interface SaveWorkflowHistoryCommand {
  readonly record: WorkflowHistoryRecord;
  readonly event?: WorkflowHistoryEvent;
}

export interface WorkflowHistoryClient {
  list(query: WorkflowHistoryQuery): Promise<WorkflowHistoryPage>;
  get(id: string): Promise<WorkflowHistoryDetail>;
  save(command: SaveWorkflowHistoryCommand): Promise<WorkflowHistoryRecord>;
  recover(): Promise<number>;
}

const phaseSchema = v.picklist([
  "idle",
  "planning",
  "awaiting_approval",
  "generating",
  "qc",
  "composing",
  "done",
  "failed",
  "paused",
]);
const snapshotSchema = v.custom<KnowledgeVideoWorkflowNodeData>((input) => {
  if (!input || typeof input !== "object") return false;
  const node = input as Partial<KnowledgeVideoWorkflowNodeData>;
  return (
    node.kind === "knowledge_video_workflow" &&
    typeof node.key === "string" &&
    typeof node.x === "number" &&
    typeof node.y === "number" &&
    !!node.config &&
    typeof node.config.brief === "string" &&
    !!node.config.models &&
    node.config.checkpoint?.version === 1
  );
});
const recordSchema = v.object({
  id: v.string(),
  canvasId: v.string(),
  sourceNodeId: v.string(),
  workflowKind: v.picklist([
    "knowledge",
    "film",
    "comicDrama",
    "commerce",
    "remotion",
    "xhsCover",
    "reverseVideo",
  ]),
  title: v.string(),
  status: phaseSchema,
  progress: v.number(),
  message: v.string(),
  error: v.nullable(v.string()),
  nodeSnapshot: snapshotSchema,
  models: v.array(
    v.object({
      role: v.picklist(["text", "image", "video"]),
      providerId: v.string(),
      providerName: v.string(),
      modelDefinitionId: v.string(),
      modelName: v.string(),
    }),
  ),
  attemptCount: v.number(),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
const eventSchema = v.object({
  id: v.string(),
  phase: phaseSchema,
  progress: v.number(),
  message: v.string(),
  error: v.nullable(v.string()),
  createdAt: v.number(),
});

async function desktop<T extends v.GenericSchema>(
  name: string,
  schema: T,
  args?: Record<string, unknown>,
): Promise<v.InferOutput<T>> {
  if (!isDesktopRuntime()) throw new Error("工作流历史记录需要在桌面应用中使用。");
  const result: unknown = await invoke(name, args);
  const parsed = v.safeParse(schema, result);
  if (!parsed.success) throw new Error("工作流历史记录格式无效，请保留当前画布并重试读取。");
  return parsed.output;
}

export const workflowHistoryClient: WorkflowHistoryClient = {
  list(query) {
    if (!isDesktopRuntime()) return Promise.resolve({ items: [], nextCursor: null });
    return desktop(
      "list_workflow_history",
      v.object({ items: v.array(recordSchema), nextCursor: v.nullable(v.string()) }),
      { query },
    );
  },
  get(id) {
    return desktop(
      "get_workflow_history",
      v.object({
        record: recordSchema,
        events: v.array(eventSchema),
        tasks: v.array(
          v.custom<GenerationTaskSummary>(
            (input) =>
              !!input &&
              typeof input === "object" &&
              typeof (input as Partial<GenerationTaskSummary>).id === "string",
          ),
        ),
      }),
      { id },
    );
  },
  save(command) {
    return desktop("save_workflow_history", recordSchema, { command });
  },
  recover() {
    if (!isDesktopRuntime()) return Promise.resolve(0);
    return desktop("recover_workflow_history", v.number());
  },
};
