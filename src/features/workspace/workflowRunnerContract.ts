/*
 * 工作流运行器的中性合同。
 *
 * 为什么需要这一层
 * ----------------
 * 全部 11 个工作流 runner 的请求、运行器与依赖类型此前寄生在
 * `knowledgeVideoWorkflowRunner.ts` 里 —— 那只是第一个使用这套封装的工作流，
 * 并非合同的所有者。其余 10 个 runner 不得不从一个具体工作流的文件里 import
 * 自己的合同，名字还带着「KnowledgeVideo」前缀。本模块把合同搬到一个
 * 中性位置：类型只此一份，任何工作流（含未来的）都在同一处对齐执行语义。
 *
 * 这里只有类型，没有实现；实现引擎仍是 `createKnowledgeVideoWorkflowRunner`
 * 及其 `VideoWorkflowDefinition` 派生机制。
 */
import type {
  ExplicitMediaInput,
  GenerationTaskClient,
  PromptNodeClient,
  PromptVisionImageInput,
  ProviderCatalogEntry,
  TextSkillMode,
  VideoCompositionJobRecord,
  VideoComposerClient,
  VideoFrameExtractionClient,
} from "../../lib/backend";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowNodeData,
  KnowledgeVideoWorkflowRunState,
  KnowledgeVideoWorkflowShot,
} from "./workspaceModel";

export interface WorkflowPlan {
  readonly documentsOnly?: boolean;
  readonly manifest: string;
  readonly aspectRatio: string;
  readonly script: string;
  readonly storyboard: string;
  readonly shots: readonly KnowledgeVideoWorkflowShot[];
  readonly decision: KnowledgeVideoWorkflowCheckpoint["decision"];
}

export interface KnowledgeVideoWorkflowRunRequest {
  readonly node: KnowledgeVideoWorkflowNodeData;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly resume?: boolean;
  readonly decisionResolution?: string;
  readonly signal: AbortSignal;
  /** Recorded execution flushes its approved checkpoint before local renderer/composer effects too. */
  readonly beforeSideEffect?: () => Promise<void>;
  readonly onCheckpoint: (checkpoint: KnowledgeVideoWorkflowCheckpoint) => void;
  readonly onProgress: (state: KnowledgeVideoWorkflowRunState) => void;
}

export interface KnowledgeVideoWorkflowRunner {
  run(request: KnowledgeVideoWorkflowRunRequest): Promise<KnowledgeVideoWorkflowCheckpoint>;
}

export interface KnowledgeVideoWorkflowRunnerDependencies {
  readonly promptClient: PromptNodeClient;
  readonly generationClient: GenerationTaskClient;
  readonly frameClient: VideoFrameExtractionClient;
  readonly composerClient: VideoComposerClient;
  readonly now: () => number;
  readonly createId: () => string;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface WorkflowPlanningContext {
  readonly request: KnowledgeVideoWorkflowRunRequest;
  readonly dependencies: KnowledgeVideoWorkflowRunnerDependencies;
  readonly checkpoint: () => KnowledgeVideoWorkflowCheckpoint;
  readonly commit: (
    update: (current: KnowledgeVideoWorkflowCheckpoint) => KnowledgeVideoWorkflowCheckpoint,
  ) => void;
  readonly progress: KnowledgeVideoWorkflowRunRequest["onProgress"];
  readonly resolution?: string;
}

export interface VideoWorkflowDefinition {
  readonly isPlanningComplete?: (checkpoint: KnowledgeVideoWorkflowCheckpoint) => boolean;
  readonly validateResume?: (
    request: KnowledgeVideoWorkflowRunRequest,
    checkpoint: KnowledgeVideoWorkflowCheckpoint,
  ) => void | Promise<void>;
  readonly requiresMediaReview?: boolean;
  readonly forceComposition?: boolean;
  readonly validateMedia?: (context: WorkflowPlanningContext) => void | Promise<void>;
  /** Fixed product/person files are prepared by the workflow instead of generated assets. */
  readonly handlesShotImageReferences?: boolean;
  readonly shotQcContext?: (
    context: WorkflowPlanningContext,
    shot: KnowledgeVideoWorkflowShot,
  ) => Promise<{ readonly references: readonly PromptVisionImageInput[]; readonly prompt: string }>;
  readonly prepareShotMedia?: (
    context: WorkflowPlanningContext,
    shot: KnowledgeVideoWorkflowShot,
  ) => Promise<readonly ExplicitMediaInput[]>;
  /** Prepare workflow-specific media and pause for its review before final composition. */
  readonly prepareComposition?: (
    context: WorkflowPlanningContext,
    clips: readonly { shot: KnowledgeVideoWorkflowShot; path: string }[],
  ) => Promise<boolean>;
  readonly startComposition?: (
    context: WorkflowPlanningContext,
    clips: readonly { shot: KnowledgeVideoWorkflowShot; path: string }[],
  ) => Promise<VideoCompositionJobRecord>;
  readonly validateDelivery?: (
    context: WorkflowPlanningContext,
    finalPath: string,
  ) => Promise<void>;
  readonly qcMode?: TextSkillMode;
  readonly title: string;
  readonly plan: (context: WorkflowPlanningContext) => Promise<WorkflowPlan>;
  readonly initialize: (
    previous: KnowledgeVideoWorkflowCheckpoint,
  ) => Partial<KnowledgeVideoWorkflowCheckpoint>;
}

/** 录制执行层实际下发给 runner 的客户端集合；其余依赖由各 runner 自带默认值。 */
export interface RecordedClients {
  readonly promptClient: PromptNodeClient;
  readonly generationClient: GenerationTaskClient;
}
