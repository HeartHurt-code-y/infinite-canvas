import type { ProviderCatalogEntry } from "../../lib/backend";
import type { CanvasNodeEntry } from "../canvas/canvasStore";
import { createAiFilmCheckpoint, createAiFilmWorkflowOptions } from "./aiFilmWorkflowModel";
import { createComicDramaCheckpoint, createComicDramaOptions } from "./comicDramaWorkflowModel";
import { createMusicVideoCheckpoint, createMusicVideoOptions } from "./musicVideoWorkflowModel";
import { createCommerceCheckpoint, createCommerceOptions } from "./commerceWorkflowModel";
import { createRemotionCheckpoint, createRemotionOptions } from "./remotionWorkflowModel";
import { createXhsCoverCheckpoint, createXhsCoverOptions } from "./xhsCoverWorkflowModel";
import {
  createProductSceneCheckpoint,
  createProductSceneOptions,
} from "./productSceneWorkflowModel";
import {
  createReverseVideoCheckpoint,
  createReverseVideoOptions,
} from "./reverseVideoWorkflowModel";
import {
  KNOWLEDGE_VIDEO_WORKFLOW_NODE_HEIGHT,
  createKnowledgeVideoWorkflowConfig,
  knowledgeVideoWorkflowNodeWidth,
  knowledgeVideoWorkflowNodeKey,
  nearestAvailableNodePosition,
  reconcileNodeModelSelection,
  reconcileTextModelSelection,
  type AssetEdgeData,
  type CanvasNodeRect,
  type NodeModelSelections,
} from "./workspaceModel";

export const KNOWLEDGE_VIDEO_DIRECTOR_TEMPLATE_ID = "knowledge-video-director-v2.4";
export const KNOWLEDGE_VIDEO_DIRECTOR_TEMPLATE_TITLE = "知识教学视频导演 V2.4";
export const AI_FILM_WORKFLOW_TEMPLATE_ID = "ai-film-workflow-v1.3";
export const COMIC_DRAMA_WORKFLOW_TEMPLATE_ID = "comic-drama-workflow-v2.3";
export const MUSIC_VIDEO_WORKFLOW_TEMPLATE_ID = "music-video-workflow-v1.0.6";
export const COMMERCE_WORKFLOW_TEMPLATE_ID = "commerce-video-workflow-v1";
export const REMOTION_WORKFLOW_TEMPLATE_ID = "remotion-animation-workflow-v1";
export const XHS_COVER_WORKFLOW_TEMPLATE_ID = "xhs-cover-workflow-v1";
export const REVERSE_VIDEO_WORKFLOW_TEMPLATE_ID = "reverse-video-workflow-v1.1";

export interface WorkflowTemplateAnchor {
  /** 工作流节点的目标中心点。 */
  readonly x: number;
  readonly y: number;
}

export interface CreateKnowledgeVideoDirectorWorkflowOptions {
  readonly anchor: WorkflowTemplateAnchor;
  readonly occupied: readonly CanvasNodeRect[];
  readonly viewportWidth?: number;
  readonly nodeModelSelections: NodeModelSelections;
  readonly providerCatalog: readonly ProviderCatalogEntry[];
  readonly providerCatalogLoaded: boolean;
}

/**
 * 保留既有返回外形，让仓库入口无需同步切换调用协议；新的模板只包含一个复合工作流
 * 节点，所有业务阶段和中间任务均由节点内部编排。
 */
export interface WorkflowTemplateSubgraph {
  readonly nodes: readonly CanvasNodeEntry[];
  readonly edges: readonly AssetEdgeData[];
  readonly bounds: CanvasNodeRect;
  readonly selectedNodeKey: string;
}

export function createKnowledgeVideoDirectorWorkflow(
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
): WorkflowTemplateSubgraph {
  const width = knowledgeVideoWorkflowNodeWidth(options.viewportWidth);
  const desiredBounds: CanvasNodeRect = {
    x: options.anchor.x - width / 2,
    y: options.anchor.y - KNOWLEDGE_VIDEO_WORKFLOW_NODE_HEIGHT / 2,
    width,
    height: KNOWLEDGE_VIDEO_WORKFLOW_NODE_HEIGHT,
  };
  const position = nearestAvailableNodePosition(desiredBounds, options.occupied);
  const bounds = { ...desiredBounds, ...position };
  const key = knowledgeVideoWorkflowNodeKey();

  const reconciledSelections: NodeModelSelections = {
    prompt: reconcileTextModelSelection(
      options.nodeModelSelections.prompt,
      options.providerCatalog,
    ),
    image: reconcileNodeModelSelection(
      "image",
      options.nodeModelSelections.image,
      options.providerCatalog,
      "text_to_image",
    ),
    video: reconcileNodeModelSelection(
      "video",
      options.nodeModelSelections.video,
      options.providerCatalog,
      "video_generation",
    ),
  };

  const node: CanvasNodeEntry = {
    type: "knowledgeVideoWorkflow",
    data: {
      key,
      kind: "knowledge_video_workflow",
      x: position.x,
      y: position.y,
      config: createKnowledgeVideoWorkflowConfig(
        reconciledSelections,
        options.providerCatalogLoaded,
      ),
    },
  };

  return { nodes: [node], edges: [], bounds, selectedNodeKey: key };
}

export function createAiFilmWorkflow(
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
): WorkflowTemplateSubgraph {
  const template = createKnowledgeVideoDirectorWorkflow(options);
  return {
    ...template,
    nodes: template.nodes.map((entry) =>
      entry.type === "knowledgeVideoWorkflow"
        ? {
            ...entry,
            data: {
              ...entry.data,
              config: {
                ...entry.data.config,
                film: createAiFilmWorkflowOptions(),
                checkpoint: { ...entry.data.config.checkpoint, film: createAiFilmCheckpoint() },
              },
            },
          }
        : entry,
    ),
  };
}

export function createComicDramaWorkflow(
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
): WorkflowTemplateSubgraph {
  const template = createKnowledgeVideoDirectorWorkflow(options);
  return {
    ...template,
    nodes: template.nodes.map((entry) =>
      entry.type === "knowledgeVideoWorkflow"
        ? {
            ...entry,
            data: {
              ...entry.data,
              config: {
                ...entry.data.config,
                comicDrama: createComicDramaOptions(),
                checkpoint: {
                  ...entry.data.config.checkpoint,
                  comicDrama: createComicDramaCheckpoint(),
                  film: createAiFilmCheckpoint(),
                },
              },
            },
          }
        : entry,
    ),
  };
}

export function createMusicVideoWorkflow(
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
): WorkflowTemplateSubgraph {
  const template = createKnowledgeVideoDirectorWorkflow(options);
  return {
    ...template,
    nodes: template.nodes.map((entry) =>
      entry.type === "knowledgeVideoWorkflow"
        ? {
            ...entry,
            data: {
              ...entry.data,
              config: {
                ...entry.data.config,
                musicVideo: createMusicVideoOptions(),
                checkpoint: {
                  ...entry.data.config.checkpoint,
                  musicVideo: createMusicVideoCheckpoint(),
                  film: createAiFilmCheckpoint(),
                },
              },
            },
          }
        : entry,
    ),
  };
}

export function createCommerceWorkflow(
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
): WorkflowTemplateSubgraph {
  const template = createKnowledgeVideoDirectorWorkflow(options);
  return {
    ...template,
    nodes: template.nodes.map((entry) =>
      entry.type === "knowledgeVideoWorkflow"
        ? {
            ...entry,
            data: {
              ...entry.data,
              config: {
                ...entry.data.config,
                commerce: createCommerceOptions(),
                checkpoint: {
                  ...entry.data.config.checkpoint,
                  commerce: createCommerceCheckpoint(),
                  film: createAiFilmCheckpoint(),
                },
              },
            },
          }
        : entry,
    ),
  };
}

export function createXhsCoverWorkflow(
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
): WorkflowTemplateSubgraph {
  const template = createKnowledgeVideoDirectorWorkflow(options);
  return {
    ...template,
    nodes: template.nodes.map((entry) =>
      entry.type === "knowledgeVideoWorkflow"
        ? {
            ...entry,
            data: {
              ...entry.data,
              config: {
                ...entry.data.config,
                models: {
                  text: entry.data.config.models.text,
                  image: reconcileNodeModelSelection(
                    "image",
                    options.nodeModelSelections.image,
                    options.providerCatalog,
                    "image_to_image",
                  ),
                  video: { providerId: "", modelDefinitionId: "" },
                },
                xhsCover: createXhsCoverOptions(),
                checkpoint: {
                  ...entry.data.config.checkpoint,
                  xhsCover: createXhsCoverCheckpoint(),
                },
              },
            },
          }
        : entry,
    ),
  };
}

export function createProductSceneWorkflow(
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
): WorkflowTemplateSubgraph {
  const template = createKnowledgeVideoDirectorWorkflow(options);
  return {
    ...template,
    nodes: template.nodes.map((entry) =>
      entry.type === "knowledgeVideoWorkflow"
        ? {
            ...entry,
            data: {
              ...entry.data,
              config: {
                ...entry.data.config,
                models: {
                  text: { providerId: "", modelDefinitionId: "" },
                  image: reconcileNodeModelSelection(
                    "image",
                    options.nodeModelSelections.image,
                    options.providerCatalog,
                    "image_to_image",
                  ),
                  video: { providerId: "", modelDefinitionId: "" },
                },
                productScene: createProductSceneOptions(),
                checkpoint: {
                  ...entry.data.config.checkpoint,
                  productScene: createProductSceneCheckpoint(),
                },
              },
            },
          }
        : entry,
    ),
  };
}

export function createRemotionWorkflow(
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
): WorkflowTemplateSubgraph {
  const template = createKnowledgeVideoDirectorWorkflow(options);
  return {
    ...template,
    nodes: template.nodes.map((entry) =>
      entry.type === "knowledgeVideoWorkflow"
        ? {
            ...entry,
            data: {
              ...entry.data,
              config: {
                ...entry.data.config,
                models: {
                  text: entry.data.config.models.text,
                  image: { providerId: "", modelDefinitionId: "" },
                  video: { providerId: "", modelDefinitionId: "" },
                },
                remotion: createRemotionOptions(),
                checkpoint: {
                  ...entry.data.config.checkpoint,
                  remotion: createRemotionCheckpoint(),
                },
              },
            },
          }
        : entry,
    ),
  };
}

export function createReverseVideoWorkflow(
  options: CreateKnowledgeVideoDirectorWorkflowOptions,
): WorkflowTemplateSubgraph {
  const template = createKnowledgeVideoDirectorWorkflow(options);
  return {
    ...template,
    nodes: template.nodes.map((entry) =>
      entry.type === "knowledgeVideoWorkflow"
        ? {
            ...entry,
            data: {
              ...entry.data,
              config: {
                ...entry.data.config,
                models: {
                  text: entry.data.config.models.text,
                  image: { providerId: "", modelDefinitionId: "" },
                  video: { providerId: "", modelDefinitionId: "" },
                },
                reverseVideo: createReverseVideoOptions(),
                checkpoint: {
                  ...entry.data.config.checkpoint,
                  reverseVideo: createReverseVideoCheckpoint(),
                },
              },
            },
          }
        : entry,
    ),
  };
}
