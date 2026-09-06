import { vi } from "vitest";
import type {
  GenerationTaskClient,
  GenerationTaskDetail,
  OptimizeVideoPromptCommand,
  PromptNodeClient,
  ProviderCatalogEntry,
  StartGenerationCommand,
  VideoComposerClient,
  VideoCompositionJobRecord,
  VideoFrameExtractionClient,
  VideoFrameExtractionJobRecord,
} from "../lib/backend";
import { defaultModelOperationSchema } from "../lib/modelCapabilities";
import {
  createKnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowNodeData,
} from "../features/workspace/workspaceModel";

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
        definitionId: "project-text",
        remoteModelId: "project-text",
        displayName: "项目文本模型",
        operations: ["text_generation"],
        operationSchema: defaultModelOperationSchema("project-text", ["text_generation"]),
      },
      {
        definitionId: "project-image",
        remoteModelId: "project-image",
        displayName: "项目图片模型",
        operations: ["text_to_image"],
        operationSchema: defaultModelOperationSchema("project-image", ["text_to_image"]),
      },
      {
        definitionId: "project-video",
        remoteModelId: "project-video",
        displayName: "项目视频模型",
        operations: ["video_generation"],
        operationSchema: {
          video_generation: {
            parameters: {
              aspect_ratio: { type: "string", default: "16:9", enum: ["16:9", "9:16"] },
              duration: { type: "integer", default: 5, enum: [4, 5, 6] },
            },
          },
        },
      },
    ],
  },
];

const planJson = (decision: object | null = null, aspectRatio = "16:9") =>
  JSON.stringify({
    schemaVersion: "knowledge-video-director.manifest.v1",
    workflowVersion: "2.4",
    status: decision ? "needs_confirmation" : "ready",
    project: {
      title: "RAG 入门",
      inputSummary: "销售团队 RAG 入门",
      aspectRatio,
      resolution: "1920x1080",
      audience: "成人零基础",
      targetDurationSeconds: 60,
      plannedDurationSeconds: 30,
      style: "现代科教风",
      pace: "中速",
      language: "zh-CN",
      lecturerMode: false,
      assumptions: ["使用默认画幅"],
    },
    diagnosis: {
      mainConcept: "RAG",
      subConcepts: ["检索", "生成"],
      keyTerms: ["知识库"],
      contentFit: "fit",
      issues: [],
      omissions: [],
    },
    styleAnchor: { id: "STYLE-A", description: "明亮简洁的现代科教风" },
    decision,
    shots: ["HOOK", "CONCEPT", "VISUAL", "EXAMPLE", "PITFALL", "RECAP"].map((section, index) => ({
      seq: String(index + 1).padStart(2, "0"),
      section,
      track: index === 2 ? "DEMO" : "METAPHOR",
      durationSeconds: 5,
      visual: `${section} 画面`,
      narration: `${section} 旁白`,
      sfx: "轻微环境音",
      bgm: "轻快电子乐",
      styleRef: "STYLE-A",
      videoPrompt: `${section} 视频提示词`,
      continuity: "统一角色和色调",
      acceptance: [`${section} 信息清晰`],
      samplePercents: [30, 60, 80, 95, 99],
    })),
    review: {
      result: "PASS",
      checks: {
        structure: "PASS",
        timing: "PASS",
        narration: "PASS",
        exactTextHandling: "PASS",
        characterContinuity: "PASS",
        propContinuity: "PASS",
        sceneContinuity: "PASS",
        colorContinuity: "PASS",
        actionContinuity: "PASS",
        promptConsistency: "PASS",
      },
      issues: [],
    },
  });

function node(): KnowledgeVideoWorkflowNodeData {
  const config = createKnowledgeVideoWorkflowConfig(
    {
      prompt: { providerId: "project-provider", modelDefinitionId: "project-text" },
      image: { providerId: "project-provider", modelDefinitionId: "project-image" },
      video: { providerId: "project-provider", modelDefinitionId: "project-video" },
    },
    true,
  );
  return {
    key: "workflow-1",
    kind: "knowledge_video_workflow",
    x: 100,
    y: 100,
    config: { ...config, brief: "面向销售新人制作一条 RAG 入门视频" },
  };
}

function completedTask(taskId: string): GenerationTaskDetail {
  const image = taskId.startsWith("image");
  return {
    summary: {
      id: taskId,
      canvasId: "canvas",
      sourceNodeId: "workflow-1",
      operation: image ? "text_to_image" : "video_generation",
      status: "succeeded",
      queryHealth: "healthy",
      providerConnectionId: "project-provider",
      providerDisplayNameSnapshot: "项目供应商",
      modelDefinitionId: image ? "project-image" : "project-video",
      remoteModelIdSnapshot: null,
      remoteTaskId: taskId,
      progress: 100,
      tokens: null,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    },
    logicalRequest: null,
    resolvedRequest: null,
    attempts: [],
    calls: [],
    events: [],
    results: [
      {
        taskId,
        resultIndex: 0,
        mediaType: image ? "image" : "video",
        remoteTaskId: taskId,
        source: null,
        saveStatus: "succeeded",
        finalPath: image ? `C:\\output\\${taskId}.png` : `C:\\output\\${taskId}.mp4`,
        relativePath: null,
        byteSize: 100,
        mimeType: image ? "image/png" : "video/mp4",
        sha256: null,
        savedAt: 2,
        error: null,
      },
    ],
    textOutput: null,
    finalError: null,
  };
}

function fakeDependencies(
  plannerOutput: string | readonly string[],
  qcOutput: string | readonly string[] = JSON.stringify({
    result: "PASS",
    report: "五点抽帧验收通过",
  }),
) {
  let videoIndex = 0;
  const plannerOutputs: string[] =
    typeof plannerOutput === "string" ? [plannerOutput] : Array.from(plannerOutput);
  const qcOutputs: string[] = typeof qcOutput === "string" ? [qcOutput] : Array.from(qcOutput);
  const promptClient: PromptNodeClient = {
    run: vi.fn((command: OptimizeVideoPromptCommand) => {
      const output =
        command.mode === "knowledge_video_director"
          ? (plannerOutputs.shift() ?? plannerOutputs.at(-1) ?? planJson())
          : (qcOutputs.shift() ?? JSON.stringify({ result: "PASS", report: "五点抽帧验收通过" }));
      return Promise.resolve({ optimizedPrompt: output, rawModelOutput: output });
    }),
  };
  const generation: GenerationTaskClient = {
    start: vi.fn((command: StartGenerationCommand) =>
      Promise.resolve(
        command.operation === "text_to_image" ? "image-cover" : `video-${++videoIndex}`,
      ),
    ),
    get: vi.fn((taskId: string) => Promise.resolve(completedTask(taskId))),
    list: vi.fn(),
    queryVideoTaskNow: vi.fn(),
  };
  const frames: VideoFrameExtractionClient = {
    startExtraction: vi.fn((videoPath: string) =>
      Promise.resolve<VideoFrameExtractionJobRecord>({
        jobId: `frames-${videoPath}`,
        videoPath,
        status: "processing",
        progress: 0,
        frames: [],
        error: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    ),
    getJob: vi.fn((jobId: string) =>
      Promise.resolve<VideoFrameExtractionJobRecord>({
        jobId,
        videoPath: "C:\\output\\clip.mp4",
        status: "completed",
        progress: 100,
        frames: [0.3, 0.6, 0.8, 0.95, 0.99].map((percentage) => ({
          path: "C:\\output\\sample.png",
          timestampSeconds: 5 * percentage,
          width: 1280,
          height: 720,
        })),
        error: null,
        createdAt: 1,
        updatedAt: 2,
      }),
    ),
    cancelJob: vi.fn(),
  };
  const composer: VideoComposerClient = {
    getEngine: vi.fn(),
    installEngine: vi.fn(),
    startComposition: vi.fn(() =>
      Promise.resolve<VideoCompositionJobRecord>({
        jobId: "composition-1",
        status: "processing",
        progress: 10,
        finalPath: null,
        fileName: null,
        width: null,
        height: null,
        durationSeconds: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    ),
    getJob: vi.fn(() =>
      Promise.resolve<VideoCompositionJobRecord>({
        jobId: "composition-1",
        status: "completed",
        progress: 100,
        finalPath: "C:\\output\\知识教学视频-完整交付.mp4",
        fileName: "知识教学视频-完整交付.mp4",
        width: 1280,
        height: 720,
        durationSeconds: 30,
        error: null,
        createdAt: 1,
        updatedAt: 2,
      }),
    ),
    cancelJob: vi.fn(),
  };
  return { promptClient, generation, frames, composer };
}

export { catalog, planJson, node, completedTask, fakeDependencies };
