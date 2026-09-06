import { describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "../../lib/backend";
import { defaultModelOperationSchema } from "../../lib/modelCapabilities";
import { isNodeRectAvailable, type NodeModelSelections } from "./workspaceModel";
import {
  createKnowledgeVideoDirectorWorkflow,
  createAiFilmWorkflow,
  createComicDramaWorkflow,
  createCommerceWorkflow,
  createRemotionWorkflow,
  createXhsCoverWorkflow,
  createReverseVideoWorkflow,
  REVERSE_VIDEO_WORKFLOW_TEMPLATE_ID,
  REMOTION_WORKFLOW_TEMPLATE_ID,
} from "./workflowTemplates";

const catalog: readonly ProviderCatalogEntry[] = [
  {
    provider: {
      id: "project-provider",
      displayName: "项目供应商",
      adapterId: "project-adapter",
      baseUrl: "project-endpoint",
      apiKeyRef: "project-credential",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    models: [
      {
        definitionId: "project-text-model",
        remoteModelId: "project-text-remote",
        displayName: "项目文本模型",
        operations: ["text_generation"],
        operationSchema: defaultModelOperationSchema("project-text-remote", ["text_generation"]),
      },
      {
        definitionId: "project-image-model",
        remoteModelId: "project-image-remote",
        displayName: "项目图片模型",
        operations: ["text_to_image"],
        operationSchema: defaultModelOperationSchema("project-image-remote", ["text_to_image"]),
      },
      {
        definitionId: "project-video-model",
        remoteModelId: "project-video-remote",
        displayName: "项目视频模型",
        operations: ["video_generation"],
        operationSchema: defaultModelOperationSchema("project-video-remote", ["video_generation"]),
      },
    ],
  },
];

const staleSelections: NodeModelSelections = {
  prompt: { providerId: "stale-provider", modelDefinitionId: "stale-text" },
  image: { providerId: "stale-provider", modelDefinitionId: "stale-image" },
  video: { providerId: "stale-provider", modelDefinitionId: "stale-video" },
};

function createWorkflow(
  occupied: Parameters<typeof createKnowledgeVideoDirectorWorkflow>[0]["occupied"] = [],
) {
  return createKnowledgeVideoDirectorWorkflow({
    anchor: { x: 1250, y: 945 },
    occupied,
    nodeModelSelections: staleSelections,
    providerCatalog: catalog,
    providerCatalogLoaded: true,
  });
}

describe("createKnowledgeVideoDirectorWorkflow", () => {
  it("creates one reverse-video node using only the project text model and empty resumable inputs", () => {
    const workflow = createReverseVideoWorkflow({
      anchor: { x: 500, y: 500 },
      occupied: [],
      nodeModelSelections: staleSelections,
      providerCatalog: catalog,
      providerCatalogLoaded: true,
    });
    expect(REVERSE_VIDEO_WORKFLOW_TEMPLATE_ID).toBe("reverse-video-workflow-v1.1");
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.edges).toEqual([]);
    const entry = workflow.nodes[0];
    if (entry?.type !== "knowledgeVideoWorkflow") throw new Error("Missing reverse-video node");
    expect(entry.data.config.reverseVideo).toEqual({
      sourceUrl: "",
      localVideoPath: "",
      localVideoName: "",
    });
    expect(entry.data.config.models).toEqual({
      text: { providerId: "project-provider", modelDefinitionId: "project-text-model" },
      image: { providerId: "", modelDefinitionId: "" },
      video: { providerId: "", modelDefinitionId: "" },
    });
    expect(entry.data.config.checkpoint.reverseVideo).toMatchObject({
      step: "download",
      downloadJobId: null,
      evidence: null,
      delivery: null,
    });
    expect(JSON.stringify(entry.data.config)).not.toMatch(
      /https?:|apiKey|author|project-endpoint|project-credential/,
    );
  });
  it("adds one cover node and selects only a project model accepting image references", () => {
    const workflow = createXhsCoverWorkflow({
      anchor: { x: 500, y: 500 },
      occupied: [],
      nodeModelSelections: staleSelections,
      providerCatalog: [
        {
          ...catalog[0]!,
          models: [
            ...catalog[0]!.models,
            {
              definitionId: "project-reference-image",
              remoteModelId: "project-reference-remote",
              displayName: "项目参考图模型",
              operations: ["image_to_image"],
              operationSchema: defaultModelOperationSchema("project-reference-remote", [
                "image_to_image",
              ]),
            },
          ],
        },
      ],
      providerCatalogLoaded: true,
    });
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.edges).toEqual([]);
    const entry = workflow.nodes[0];
    if (entry?.type !== "knowledgeVideoWorkflow") throw new Error("Missing cover node");
    expect(entry.data.config.xhsCover).toMatchObject({
      style: "auto",
      portraits: [],
      materials: [],
      deliverable: "image",
    });
    expect(entry.data.config.models.text.providerId).toBe("project-provider");
    expect(entry.data.config.models.image).toEqual({
      providerId: "project-provider",
      modelDefinitionId: "project-reference-image",
    });
    expect(entry.data.config.models.video.providerId).toBe("");
    expect(entry.data.config.checkpoint.xhsCover?.plan).toBeNull();
    expect(JSON.stringify(entry)).not.toContain("project-endpoint");
    expect(JSON.stringify(entry)).not.toContain("project-credential");
  });
  it("adds a single animation node requiring only a project text model", () => {
    const workflow = createRemotionWorkflow({
      anchor: { x: 500, y: 500 },
      occupied: [],
      nodeModelSelections: staleSelections,
      providerCatalog: catalog,
      providerCatalogLoaded: true,
    });
    expect(REMOTION_WORKFLOW_TEMPLATE_ID).toBe("remotion-animation-workflow-v1");
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.edges).toEqual([]);
    const entry = workflow.nodes[0];
    if (entry?.type !== "knowledgeVideoWorkflow") throw new Error("Missing animation node");
    expect(entry.data.config.remotion).toEqual({
      template: "auto",
      width: 800,
      height: 600,
      durationSeconds: 8,
      theme: "morandi",
      format: "gif",
    });
    expect(entry.data.config.models.text.providerId).toBe("project-provider");
    expect(entry.data.config.models.image.providerId).toBe("");
    expect(entry.data.config.models.video.providerId).toBe("");
    expect(entry.data.config.checkpoint.remotion?.plan).toBeNull();
    expect(entry.data.config.film).toBeUndefined();
    expect(entry.data.config.commerce).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("project-endpoint");
    expect(JSON.stringify(entry)).not.toContain("project-credential");
  });
  it("adds a single commerce node with a fresh checkpoint and project-only selections", () => {
    const workflow = createCommerceWorkflow({
      anchor: { x: 500, y: 500 },
      occupied: [],
      nodeModelSelections: staleSelections,
      providerCatalog: catalog,
      providerCatalogLoaded: true,
    });
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.edges).toEqual([]);
    const entry = workflow.nodes[0];
    if (entry?.type !== "knowledgeVideoWorkflow") throw new Error("Missing commerce node");
    expect(entry.data.config.commerce).toMatchObject({
      mode: "quick",
      storyType: "智能推荐",
      materials: [],
      deliverable: "video",
    });
    expect(entry.data.config.film).toBeUndefined();
    expect(entry.data.config.comicDrama).toBeUndefined();
    expect(entry.data.config.models.text.providerId).toBe("project-provider");
    expect(entry.data.config.checkpoint.commerce?.stages).toEqual({});
    expect(JSON.stringify(entry)).not.toContain("project-endpoint");
    expect(JSON.stringify(entry)).not.toContain("project-credential");
  });
  it("adds a single comic drama node using the project model catalog", () => {
    const workflow = createComicDramaWorkflow({
      anchor: { x: 500, y: 500 },
      occupied: [],
      nodeModelSelections: staleSelections,
      providerCatalog: catalog,
      providerCatalogLoaded: true,
    });
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.edges).toEqual([]);
    const entry = workflow.nodes[0];
    if (entry?.type !== "knowledgeVideoWorkflow") throw new Error("Missing drama node");
    expect(entry.data.config.comicDrama?.episodes).toEqual([
      { id: "ep01", title: "第 1 集", script: "" },
    ]);
    expect(entry.data.config.film).toBeUndefined();
    expect(entry.data.config.models.text.providerId).toBe("project-provider");
    expect(entry.data.config.checkpoint.comicDrama?.sharedAssets).toEqual([]);
    expect(JSON.stringify(entry)).not.toContain("project-endpoint");
  });
  it("inserts the film workflow with one node and project-only model selections", () => {
    const workflow = createAiFilmWorkflow({
      anchor: { x: 500, y: 500 },
      occupied: [],
      nodeModelSelections: staleSelections,
      providerCatalog: catalog,
      providerCatalogLoaded: true,
    });
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.edges).toHaveLength(0);
    const entry = workflow.nodes[0];
    if (entry?.type !== "knowledgeVideoWorkflow") throw new Error("Missing film node");
    expect(entry.data.config.film).toEqual({
      entryStage: "auto",
      sourceText: "",
      deliverable: "video",
    });
    expect(entry.data.config.models.video.providerId).toBe("project-provider");
    expect(entry.data.config.checkpoint.film?.artifacts).toEqual([]);
    expect(JSON.stringify(entry)).not.toContain("project-endpoint");
  });
  it("creates one composite workflow node without exposing internal edges", () => {
    const workflow = createWorkflow();

    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.edges).toEqual([]);
    expect(workflow.nodes[0]).toMatchObject({
      type: "knowledgeVideoWorkflow",
      data: { kind: "knowledge_video_workflow" },
    });
    expect(workflow.selectedNodeKey).toBe(workflow.nodes[0]?.data.key);
  });

  it("defaults to automatic execution with a resumable empty checkpoint", () => {
    const workflow = createWorkflow();
    const entry = workflow.nodes[0];
    if (entry?.type !== "knowledgeVideoWorkflow") throw new Error("Workflow node is missing");

    expect(entry.data.config.approvalPolicy).toBe("exceptions_only");
    expect(entry.data.config.maxAutomaticRetries).toBe(2);
    expect(entry.data.config.checkpoint).toEqual({
      version: 1,
      runId: null,
      phase: "idle",
      planRevision: 0,
      approvedPlanRevision: null,
      manifest: "",
      script: "",
      storyboard: "",
      shots: [],
      shotRuns: {},
      decision: null,
      lastActivePhase: null,
      coverImagePath: null,
      activeCompositionJobId: null,
      finalPath: null,
      error: null,
      updatedAt: null,
    });
  });

  it("reconciles all model roles exclusively against the supplied project catalog", () => {
    const workflow = createWorkflow();
    const entry = workflow.nodes[0];
    if (entry?.type !== "knowledgeVideoWorkflow") throw new Error("Workflow node is missing");

    expect(entry.data.config.models).toEqual({
      text: { providerId: "project-provider", modelDefinitionId: "project-text-model" },
      image: { providerId: "project-provider", modelDefinitionId: "project-image-model" },
      video: { providerId: "project-provider", modelDefinitionId: "project-video-model" },
    });
    expect(JSON.stringify(entry.data.config)).not.toContain("project-endpoint");
    expect(JSON.stringify(entry.data.config)).not.toContain("project-credential");
  });

  it("creates a fresh node identity for every instantiation", () => {
    const first = createWorkflow();
    const second = createWorkflow();

    expect(first.nodes[0]?.data.key).not.toBe(second.nodes[0]?.data.key);
  });

  it("moves the whole composite node to avoid occupied canvas nodes", () => {
    const initial = createWorkflow();
    const occupied = [{ ...initial.bounds }];
    const moved = createWorkflow(occupied);

    expect(isNodeRectAvailable(moved.bounds, occupied)).toBe(true);
    expect(moved.bounds).not.toEqual(initial.bounds);
    expect(moved.nodes[0]?.data).toMatchObject({ x: moved.bounds.x, y: moved.bounds.y });
  });
});
