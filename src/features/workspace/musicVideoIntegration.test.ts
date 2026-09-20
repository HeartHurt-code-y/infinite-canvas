import { describe, expect, it, vi } from "vitest";
import { catalog, node } from "../../test/videoWorkflowFixtures";
import type { SaveWorkflowHistoryCommand } from "../../lib/workflowHistory";
import { createCanvasState } from "../canvas/canvasStore";
import { createMusicVideoWorkflow } from "./workflowTemplates";
import { createMusicVideoCheckpoint, createMusicVideoOptions } from "./musicVideoWorkflowModel";
import {
  approveWorkflowExecutionPlan,
  createWorkflowDeliveryPlan,
  createWorkflowExecutionPlan,
  isWorkflowExecutionPlanApproved,
  topologicallySortWorkflowSteps,
} from "./workflowExecutionPlan";
import {
  createRecordedWorkflowRunner,
  workflowKindForNode,
  type RecordedWorkflowDependencies,
} from "./workflowHistoryExecution";
import {
  redoWorkflowVersion,
  restoreWorkflowVersion,
  undoWorkflowVersion,
  workflowVersionState,
} from "./workflowVersionHistory";
import type {
  KnowledgeVideoWorkflowConfig,
  KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

function mvNode(key = "music-workflow"): KnowledgeVideoWorkflowNodeData {
  const source = node();
  return {
    ...source,
    key,
    config: {
      ...source.config,
      brief: "",
      musicVideo: {
        ...createMusicVideoOptions(),
        songPath: "C:/songs/original.mp3",
        songName: "原曲",
        deliverable: "documents",
      },
      checkpoint: { ...source.config.checkpoint, musicVideo: createMusicVideoCheckpoint() },
    },
  };
}

describe("native music-video workflow integration", () => {
  it("creates one MV node using only enabled project model identities", () => {
    const template = createMusicVideoWorkflow({
      anchor: { x: 500, y: 500 },
      occupied: [],
      providerCatalog: catalog,
      providerCatalogLoaded: true,
      nodeModelSelections: {
        prompt: { providerId: "old", modelDefinitionId: "old-text" },
        image: { providerId: "old", modelDefinitionId: "old-image" },
        video: { providerId: "old", modelDefinitionId: "old-video" },
      },
    });
    expect(template.nodes).toHaveLength(1);
    expect(template.edges).toEqual([]);
    const entry = template.nodes[0];
    if (entry?.type !== "knowledgeVideoWorkflow") throw new Error("Missing MV node");
    expect(workflowKindForNode(entry.data)).toBe("musicVideo");
    expect(entry.data.config.musicVideo).toEqual(createMusicVideoOptions());
    expect(entry.data.config.checkpoint.musicVideo).toEqual(createMusicVideoCheckpoint());
    expect(entry.data.config.models).toEqual({
      text: { providerId: "project-provider", modelDefinitionId: "project-text" },
      image: { providerId: "project-provider", modelDefinitionId: "project-image" },
      video: { providerId: "project-provider", modelDefinitionId: "project-video" },
    });
    expect(JSON.stringify(entry)).not.toMatch(
      /https?:|apiKey|RunningHub|workflowId|project-endpoint|project-key/,
    );
  });

  it("orders the real MV review plan and invalidates approval when song, lyrics or style changes", () => {
    const source = mvNode();
    const videoNode = {
      ...source,
      config: {
        ...source.config,
        musicVideo: { ...source.config.musicVideo!, deliverable: "video" as const },
      },
    };
    const plan = createWorkflowExecutionPlan(videoNode);
    const ordered = topologicallySortWorkflowSteps([...plan.steps].reverse());
    expect(ordered.map(({ title }) => title)).toEqual([
      "读取原曲并审核完整歌词时间线",
      "确认视觉风格与人物设定",
      "确认逐段分镜与音乐窗口",
      "审核视频提示词与唱词、嘴型策略",
      "确认镜头依赖与制作计划",
      "确认人物及场景资产",
      "首镜试产并人工审核",
      "按依赖生成并逐段检查",
      "选用片段并按原曲窗口合成",
      "检查音视频时长并预览确认成片",
    ]);
    const approved = approveWorkflowExecutionPlan(plan, videoNode, 1);
    expect(isWorkflowExecutionPlanApproved(approved, { ...videoNode, x: 800 })).toBe(true);
    for (const patch of [
      { songPath: "C:/songs/replaced.mp3" },
      { lrc: "[00:01.00]改后歌词" },
      { officialLyrics: "更正的完整歌词" },
      { visualStyle: "新的视觉风格" },
    ]) {
      expect(
        isWorkflowExecutionPlanApproved(approved, {
          ...videoNode,
          config: {
            ...videoNode.config,
            musicVideo: { ...videoNode.config.musicVideo, ...patch },
          },
        }),
      ).toBe(false);
    }
    const authored = {
      ...source,
      config: {
        ...source.config,
        checkpoint: {
          ...source.config.checkpoint,
          musicVideo: {
            ...createMusicVideoCheckpoint(),
            stages: {
              timeline: {
                artifact: {
                  version: 1,
                  createdAt: 1,
                  content: "原始时间轴",
                  inputSummary: "用户 LRC",
                  timeline: [],
                },
                review: null,
                history: [],
              },
            },
          },
        },
      },
    };
    const delivery = approveWorkflowExecutionPlan(
      createWorkflowDeliveryPlan(authored),
      authored,
      2,
    );
    expect(isWorkflowExecutionPlanApproved(delivery, authored)).toBe(true);
    expect(
      isWorkflowExecutionPlanApproved(delivery, {
        ...authored,
        config: {
          ...authored.config,
          checkpoint: {
            ...authored.config.checkpoint,
            musicVideo: {
              ...authored.config.checkpoint.musicVideo,
              stages: {
                timeline: {
                  ...authored.config.checkpoint.musicVideo.stages.timeline,
                  artifact: {
                    ...authored.config.checkpoint.musicVideo.stages.timeline.artifact,
                    content: "已改时间轴",
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("does not dispatch or persist until explicit plan approval, then records the musicVideo kind", async () => {
    const original = mvNode();
    const source = { ...original, config: { ...original.config, historyRunId: "mv-history" } };
    const save = vi.fn(({ record }: SaveWorkflowHistoryCommand) =>
      Promise.resolve({
        ...record,
        revision: record.revision + 1,
      }),
    );
    const factory = vi.fn<RecordedWorkflowDependencies["runnerFactory"]>(() => ({
      run: (request) => {
        const done = {
          ...request.node.config.checkpoint,
          phase: "done" as const,
          documentsOnly: true,
        };
        request.onCheckpoint(done);
        return Promise.resolve(done);
      },
    }));
    const runner = createRecordedWorkflowRunner({
      runnerFactory: factory,
      historyClient: { save, get: vi.fn() },
      canvasId: "music-canvas",
    });
    const request = {
      node: source,
      providerCatalog: catalog,
      signal: new AbortController().signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    };
    const pending = await runner.run(request);
    expect(pending.phase).toBe("awaiting_approval");
    expect(factory).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    const executionPlan = approveWorkflowExecutionPlan(pending.executionPlan!, source);
    const completed = await runner.run({
      ...request,
      node: {
        ...source,
        config: { ...source.config, executionPlan, checkpoint: { ...pending, executionPlan } },
      },
    });
    expect(completed.phase).toBe("done");
    expect(factory).toHaveBeenCalledWith("musicVideo", expect.anything());
    expect(save).toHaveBeenCalled();
    for (const [command] of save.mock.calls) {
      expect(command.record.workflowKind).toBe("musicVideo");
      expect(command.record.canvasId).toBe("music-canvas");
      expect(command.record.nodeSnapshot.config.musicVideo?.songPath).toBe("C:/songs/original.mp3");
      expect(command.record.models.map(({ role }) => role)).toEqual(["text"]);
    }
  });

  it("keeps MV edits and branches local to one workflow and excludes canvas movement", () => {
    const canvas = createCanvasState();
    canvas.commands.addNode("knowledgeVideoWorkflow", mvNode("mv-one"));
    canvas.commands.addNode("knowledgeVideoWorkflow", mvNode("mv-two"));
    const read = (key = "mv-one") =>
      canvas.getSnapshot().nodeByKey.knowledgeVideoWorkflow.get(key)!;
    const mutate = (
      change: (config: KnowledgeVideoWorkflowConfig) => KnowledgeVideoWorkflowConfig,
    ) =>
      canvas.commands.patchNode("knowledgeVideoWorkflow", "mv-one", (value) => ({
        ...value,
        config: change(value.config),
      }));
    const initial = workflowVersionState(read().config).currentVersionId;
    const second = JSON.stringify(read("mv-two"));
    mutate((config) => ({
      ...config,
      musicVideo: { ...config.musicVideo!, officialLyrics: "第一稿歌词" },
    }));
    const oldTip = workflowVersionState(read().config).currentVersionId;
    canvas.commands.applyNodeChanges([
      { type: "position", key: "mv-one", position: { x: 720, y: 420 } },
    ]);
    expect(workflowVersionState(read().config).versions).toHaveLength(2);
    mutate(undoWorkflowVersion);
    expect(read().config.musicVideo?.officialLyrics).toBe("");
    expect(read().x).toBe(720);
    mutate((config) => ({
      ...config,
      musicVideo: { ...config.musicVideo!, officialLyrics: "另一分支歌词" },
    }));
    const newTip = workflowVersionState(read().config).currentVersionId;
    expect(workflowVersionState(read().config).versions).toHaveLength(3);
    mutate((config) => restoreWorkflowVersion(config, initial));
    expect(workflowVersionState(read().config).redoVersionIds).toEqual([oldTip, newTip]);
    mutate((config) => redoWorkflowVersion(config, oldTip));
    expect(read().config.musicVideo?.officialLyrics).toBe("第一稿歌词");
    expect(read().x).toBe(720);
    expect(JSON.stringify(read("mv-two"))).toBe(second);
    expect(canvas.commands.snapshotV2({})).not.toHaveProperty("versionHistory");
  });
});
