import { describe, expect, it } from "vitest";
import {
  createKnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowNodeData,
  type KnowledgeVideoWorkflowShot,
} from "./workspaceModel";
import { approveWorkflowExecutionPlan, createWorkflowExecutionPlan } from "./workflowExecutionPlan";
import { workflowConnectedTextBlock } from "./workflowMaterials";
import { createAiFilmCheckpoint } from "./aiFilmWorkflowModel";
import { createRemotionCheckpoint, type AnimationPlan } from "./remotionWorkflowModel";
import {
  createReverseVideoCheckpoint,
  type ReverseVideoAnalysis,
} from "./reverseVideoWorkflowModel";
import {
  initializeWorkflowVersions,
  mergeWorkflowVersionHistory,
  recordWorkflowVersion,
  redoWorkflowVersion,
  restoreWorkflowVersion,
  undoWorkflowVersion,
  workflowVersionContentSignature,
  workflowVersionState,
} from "./workflowVersionHistory";

function config(): KnowledgeVideoWorkflowConfig {
  return {
    ...createKnowledgeVideoWorkflowConfig(
      {
        prompt: { providerId: "p", modelDefinitionId: "text" },
        image: { providerId: "p", modelDefinitionId: "image" },
        video: { providerId: "p", modelDefinitionId: "video" },
      },
      true,
    ),
    brief: "原始主题",
  };
}
function node(value: KnowledgeVideoWorkflowConfig): KnowledgeVideoWorkflowNodeData {
  return { key: "workflow", kind: "knowledge_video_workflow", x: 0, y: 0, config: value };
}
function edit(value: KnowledgeVideoWorkflowConfig, brief: string) {
  return recordWorkflowVersion(value, { ...value, brief });
}
const shot: KnowledgeVideoWorkflowShot = {
  id: "shot-1",
  sequence: 1,
  section: "HOOK",
  track: "DEMO",
  title: "开场",
  durationSeconds: 5,
  visual: "原始画面",
  narration: "原始旁白",
  videoPrompt: "原始提示词",
  acceptance: "清晰",
};

describe("workflow configuration version history", () => {
  it("retains unlimited immutable branches through JSON reload and targeted redo", () => {
    let current = initializeWorkflowVersions(config());
    expect(initializeWorkflowVersions(current)).toBe(current);
    for (let index = 1; index <= 205; index += 1) current = edit(current, `主题 ${index}`);
    const oldTip = workflowVersionState(current).currentVersionId;
    current = undoWorkflowVersion(current);
    const branch = workflowVersionState(current).currentVersionId;
    current = edit(current, "另一条分支");
    const newTip = workflowVersionState(current).currentVersionId;
    expect(current.versionHistory?.versions).toHaveLength(207);
    const persisted = JSON.stringify(current);
    expect(persisted.match(/"versionHistory"/g)).toHaveLength(1);
    const restored = restoreWorkflowVersion(
      JSON.parse(persisted) as KnowledgeVideoWorkflowConfig,
      branch,
    );
    expect(workflowVersionState(restored).redoVersionIds).toEqual([oldTip, newTip]);
    expect(redoWorkflowVersion(restored, oldTip).brief).toBe("主题 205");
    const oldAgain = redoWorkflowVersion(
      undoWorkflowVersion(redoWorkflowVersion(restored, oldTip)),
    );
    expect(workflowVersionState(oldAgain).currentVersionId).toBe(oldTip);
    expect(restoreWorkflowVersion(oldAgain, newTip).brief).toBe("另一条分支");
    expect(JSON.stringify(current)).toBe(persisted);
  });

  it("ignores progress, paid task identity, confirmation and injected canvas text", () => {
    const initial = initializeWorkflowVersions({
      ...config(),
      connectedTexts: [
        { key: "source", sourceKey: "source", displayName: "剧本", text: "真实参考" },
      ],
    });
    const plan = createWorkflowExecutionPlan(node(initial));
    const planned = recordWorkflowVersion(initial, { ...initial, executionPlan: plan });
    const approved = approveWorkflowExecutionPlan(plan, node(planned));
    const running = recordWorkflowVersion(planned, {
      ...planned,
      brief: `${planned.brief}\n\n${workflowConnectedTextBlock(planned)}`,
      historyRunId: "paid-history",
      executionPlan: approved,
      catalogResolved: false,
      checkpoint: {
        ...planned.checkpoint,
        runId: "paid-run",
        phase: "generating",
        updatedAt: 10,
        mediaApprovals: { assets: { signature: "approved-assets", approvedAt: 12 } },
        shotRuns: {
          [shot.id]: {
            shotId: shot.id,
            videoTaskId: "paid-video",
            qcStatus: "passed",
            retryCount: 1,
          },
        },
      },
    });
    expect(workflowVersionContentSignature(running)).toBe(workflowVersionContentSignature(planned));
    expect(running.versionHistory?.versions).toHaveLength(2);
    expect(running.versionHistory?.currentVersionId).toBe(planned.versionHistory?.currentVersionId);
    expect(running.checkpoint.shotRuns[shot.id]?.videoTaskId).toBe("paid-video");
  });

  it("accepts recorded checkpoint versions and explicit navigation without duplicate edits", () => {
    const initial = initializeWorkflowVersions(config());
    const first = edit(initial, "第一稿");
    const recorded = recordWorkflowVersion(
      first,
      {
        ...first,
        checkpoint: { ...first.checkpoint, script: "阶段成果正文", shots: [shot] },
      },
      "完成剧本阶段",
    );
    const received = recordWorkflowVersion(first, recorded);
    expect(received.versionHistory?.versions).toHaveLength(3);
    expect(received.versionHistory?.currentVersionId).toBe(
      recorded.versionHistory?.currentVersionId,
    );
    const undone = recordWorkflowVersion(received, undoWorkflowVersion(received));
    expect(undone.versionHistory?.versions).toHaveLength(3);
    expect(undone.checkpoint.script).toBe("");
    const redone = recordWorkflowVersion(undone, redoWorkflowVersion(undone));
    expect(redone.versionHistory?.versions).toHaveLength(3);
    expect(redone.checkpoint.script).toBe("阶段成果正文");
  });

  it("restores old shots without reusing incompatible clips or replaying approval", () => {
    const original = config();
    const approved = approveWorkflowExecutionPlan(
      createWorkflowExecutionPlan(node(original)),
      node(original),
    );
    const initial = initializeWorkflowVersions({
      ...original,
      executionPlan: approved,
      checkpoint: {
        ...original.checkpoint,
        shots: [shot],
        executionPlan: approved,
        mediaApprovals: { composition: { signature: "media", approvedAt: 1 } },
      },
    });
    const edited = recordWorkflowVersion(initial, {
      ...initial,
      checkpoint: { ...initial.checkpoint, shots: [{ ...shot, videoPrompt: "新镜头提示" }] },
    });
    const running = recordWorkflowVersion(edited, {
      ...edited,
      historyRunId: "history-latest",
      checkpoint: {
        ...edited.checkpoint,
        runId: "run-latest",
        phase: "done",
        finalPath: "C:/latest.mp4",
        activeCompositionJobId: "compose-latest",
        shotRuns: {
          [shot.id]: {
            shotId: shot.id,
            videoTaskId: "paid-latest",
            clipPath: "C:/clip-latest.mp4",
            qcStatus: "passed",
            retryCount: 0,
          },
        },
      },
    });
    const before = JSON.stringify(running);
    const restored = undoWorkflowVersion(running);
    expect(restored.checkpoint.shots[0]?.videoPrompt).toBe("原始提示词");
    expect(restored.checkpoint.shotRuns[shot.id]).toMatchObject({
      videoTaskId: "paid-latest",
      clipPath: "C:/clip-latest.mp4",
      promptEdited: true,
    });
    expect(restored.checkpoint.phase).toBe("paused");
    expect(restored.checkpoint.finalPath).toBeNull();
    expect(restored.checkpoint.activeCompositionJobId).toBeNull();
    expect(restored.executionPlan?.approval).toBeNull();
    expect(restored.executionPlan?.executionIntent).toBe("resume");
    expect(restored.checkpoint.executionPlan?.approval).toBeNull();
    expect(restored.checkpoint.mediaApprovals).toEqual({});
    expect(JSON.stringify(running)).toBe(before);
  });

  it("versions historical media and complete text references and restores their stable identities", () => {
    const initial = initializeWorkflowVersions({
      ...config(),
      connectedTexts: [
        {
          key: "old-text",
          sourceKey: "source",
          displayName: "历史长剧本",
          text: "完整历史正文\n第二段",
        },
      ],
      connectedMaterials: [
        {
          target: {
            kind: "asset",
            providerConnectionId: "provider",
            assetId: "image-1",
            mediaType: "image",
          },
          displayName: "历史角色参考",
        },
      ],
    });
    const removedText = recordWorkflowVersion(initial, { ...initial, connectedTexts: [] });
    const removedMedia = recordWorkflowVersion(removedText, {
      ...removedText,
      connectedMaterials: [],
    });
    expect(removedMedia.versionHistory?.versions).toHaveLength(3);
    const restored = restoreWorkflowVersion(removedMedia, initial.versionHistory!.currentVersionId);
    expect(restored.connectedTexts).toEqual(initial.connectedTexts);
    expect(restored.connectedMaterials).toEqual(initial.connectedMaterials);
    expect(restored.executionPlan?.executionIntent).toBe("restart");
    expect(restored.checkpoint.phase).toBe("awaiting_approval");
    expect(recordWorkflowVersion(removedMedia, restored).versionHistory?.versions).toHaveLength(3);
  });

  it("restores stage content without inheriting newer completion, reviews or output caches", () => {
    const base = config();
    const plan: AnimationPlan = {
      schemaVersion: "animation-plan.v1",
      template: "timeline",
      title: "旧动画方案",
      width: 800,
      height: 600,
      fps: 30,
      durationInFrames: 240,
      background: "#fff",
      palette: ["#000"],
      elements: [],
      connections: [],
      staggerFrames: 10,
      holdFrames: 30,
      springDamping: 15,
    };
    const analysis: ReverseVideoAnalysis = {
      schemaVersion: "reverse-video-analysis.v1",
      title: "旧分析",
      summary: "原始分析正文",
      dimensions: {
        subject: "",
        styling: "",
        scene: "",
        lighting: "",
        color: "",
        camera: "",
        composition: "",
        emotion: "",
        contentType: "",
        hook: "",
      },
      globalSettings: "",
      scenes: "",
      timeline: [],
      ending: { beats: [], finalFrame: "", evidence: "" },
      replicationPrompt: "",
      viralDiagnosis: { hook: "", emotion: "", memory: "", replicable: "", replace: "" },
      remixes: [],
      priority: "",
      pitfalls: [],
      keywords: [],
      tags: [],
    };
    const initial = initializeWorkflowVersions({
      ...base,
      executionPlan: createWorkflowExecutionPlan(node(base), "restart"),
      checkpoint: {
        ...base.checkpoint,
        runId: "same-run",
        phase: "planning",
        film: {
          ...createAiFilmCheckpoint(),
          artifacts: [
            {
              stage: "synopsis",
              version: 1,
              content: "旧影视概念",
              inputSummary: "",
              createdAt: 1,
            },
          ],
        },
        remotion: { ...createRemotionCheckpoint(), plan },
        reverseVideo: { ...createReverseVideoCheckpoint(), analysis, step: "review" },
      },
    });
    const authored = recordWorkflowVersion(initial, {
      ...initial,
      checkpoint: {
        ...initial.checkpoint,
        film: {
          ...initial.checkpoint.film!,
          artifacts: [
            {
              stage: "synopsis",
              version: 2,
              content: "新影视概念",
              inputSummary: "",
              createdAt: 2,
            },
          ],
        },
        remotion: { ...initial.checkpoint.remotion!, plan: { ...plan, title: "新动画方案" } },
        reverseVideo: {
          ...initial.checkpoint.reverseVideo!,
          analysis: { ...analysis, title: "新分析" },
        },
      },
    });
    const finished = recordWorkflowVersion(authored, {
      ...authored,
      checkpoint: {
        ...authored.checkpoint,
        phase: "done",
        finalPath: "C:/new-result.mp4",
        activeCompositionJobId: "latest-compose",
        film: {
          ...authored.checkpoint.film!,
          completedStages: ["synopsis"],
          planningComplete: true,
        },
        remotion: {
          ...authored.checkpoint.remotion!,
          review: { result: "PASS", report: "新稿通过" },
          renderJob: {
            id: "paid-render",
            status: "succeeded",
            progress: 100,
            message: "完成",
            videoPath: "C:/new-render.mp4",
            createdAt: 1,
            updatedAt: 2,
          },
        },
        reverseVideo: {
          ...authored.checkpoint.reverseVideo!,
          step: "done",
          review: { result: "PASS", report: "新稿通过" },
          delivery: {
            caseId: "new-case",
            directory: "C:/case",
            videoPath: "C:/new-source.mp4",
            markdownPath: "C:/new.md",
            textPath: "C:/new.txt",
            casePath: "C:/new.json",
            caseCount: 2,
          },
        },
      },
    });
    const before = JSON.stringify(finished);
    const restored = undoWorkflowVersion(finished);
    expect(restored.checkpoint.phase).toBe("paused");
    expect(restored.checkpoint.runId).toBe("same-run");
    expect(restored.checkpoint.finalPath).toBeNull();
    expect(restored.checkpoint.activeCompositionJobId).toBeNull();
    expect(restored.executionPlan?.executionIntent).toBe("resume");
    expect(restored.checkpoint.executionPlan?.approval).toBeNull();
    expect(restored.checkpoint.film).toMatchObject({
      completedStages: [],
      planningComplete: false,
      artifacts: [{ content: "旧影视概念" }],
    });
    expect(restored.checkpoint.remotion).toMatchObject({
      plan: { title: "旧动画方案" },
      review: null,
      renderJob: null,
    });
    expect(restored.checkpoint.reverseVideo).toMatchObject({
      analysis: { title: "旧分析" },
      step: "review",
      review: null,
      delivery: null,
    });
    expect(restored.versionHistory?.runtimeArchives?.[0]?.checkpoint.remotion?.renderJob?.id).toBe(
      "paid-render",
    );
    expect(
      restored.versionHistory?.runtimeArchives?.[0]?.checkpoint.reverseVideo?.delivery?.caseId,
    ).toBe("new-case");
    expect(restored.versionHistory?.versions).toHaveLength(2);
    expect(JSON.stringify(restored).match(/"versionHistory"/g)).toHaveLength(1);
    const reconciled = recordWorkflowVersion(finished, restored);
    expect(reconciled.versionHistory?.versions).toHaveLength(2);
    expect(reconciled.versionHistory?.runtimeArchives).toHaveLength(1);
    expect(JSON.stringify(finished)).toBe(before);
  });

  it("requires a fresh restart plan when input changes and clears stage approval", () => {
    const base = config();
    const initial = initializeWorkflowVersions({
      ...base,
      checkpoint: {
        ...base.checkpoint,
        comicDrama: {
          episodes: [
            {
              id: "ep1",
              title: "第一集",
              script: "剧本",
              stages: {
                screenplay: {
                  approvedVersion: 1,
                  artifact: {
                    version: 1,
                    content: "稿件",
                    inputSummary: "初稿",
                    createdAt: 1,
                    assets: [],
                    shots: [],
                  },
                  businessReview: null,
                  contentReview: null,
                  passed: true,
                  repairCount: 0,
                  history: [],
                },
              },
            },
          ],
          sharedAssets: [],
          pending: null,
          planningComplete: true,
        },
      },
    });
    const edited = edit(initial, "新的主题");
    const latest = recordWorkflowVersion(edited, {
      ...edited,
      historyRunId: "latest-history",
      checkpoint: { ...edited.checkpoint, runId: "latest-run" },
    });
    const restored = undoWorkflowVersion(latest);
    expect(restored.brief).toBe("原始主题");
    expect(restored.historyRunId).toBe("latest-history");
    expect(restored.checkpoint.runId).toBe("latest-run");
    expect(restored.executionPlan?.executionIntent).toBe("restart");
    expect(restored.checkpoint.executionPlan).toEqual(restored.executionPlan);
    expect(restored.checkpoint.phase).toBe("awaiting_approval");
    expect(
      restored.checkpoint.comicDrama?.episodes[0]?.stages.screenplay?.approvedVersion,
    ).toBeUndefined();
    expect(recordWorkflowVersion(latest, restored).versionHistory?.versions).toHaveLength(2);
  });

  it("preserves branches and newest runtime when an older canvas copy is reconciled", () => {
    const initial = initializeWorkflowVersions(config());
    const first = edit(initial, "第一稿");
    const second = edit(first, "第二稿");
    const firstAgain = mergeWorkflowVersionHistory(second, first);
    expect(firstAgain.brief).toBe("第一稿");
    expect(firstAgain.versionHistory?.versions).toHaveLength(3);
    const sibling = edit(firstAgain, "另一条分支");
    const latest = recordWorkflowVersion(sibling, {
      ...sibling,
      checkpoint: { ...sibling.checkpoint, runId: "paid-run", phase: "generating" },
    });
    const unchangedContent = mergeWorkflowVersionHistory(latest, sibling);
    expect(unchangedContent.checkpoint.runId).toBe("paid-run");
    expect(unchangedContent.checkpoint.phase).toBe("generating");
    expect(unchangedContent.versionHistory?.versions).toHaveLength(4);
    expect(
      restoreWorkflowVersion(unchangedContent, second.versionHistory!.currentVersionId).brief,
    ).toBe("第二稿");
  });

  it("does not mutate archived snapshots through a restored working copy", () => {
    const initial = initializeWorkflowVersions(config());
    const edited = edit(initial, "不同主题");
    const archive = edited.versionHistory!;
    const before = JSON.stringify(archive);
    const restored = undoWorkflowVersion(edited);
    const editableModels = restored.models.text as {
      providerId: string;
      modelDefinitionId: string;
    };
    editableModels.modelDefinitionId = "mutated-by-editor";
    expect(JSON.stringify(archive)).toBe(before);
  });

  it("rejects corrupted and conflicting histories instead of losing edits", () => {
    const original = initializeWorkflowVersions(config());
    const edited = edit(original, "新主题");
    const before = JSON.stringify(edited);
    const bad = {
      ...edited,
      versionHistory: {
        ...edited.versionHistory!,
        versions: edited.versionHistory!.versions.map((version, index) =>
          index === 0 ? { ...version, parentId: version.id } : version,
        ),
      },
    };
    expect(() => initializeWorkflowVersions(bad)).toThrow("父版本");
    const conflicting = {
      ...edited,
      versionHistory: {
        ...edited.versionHistory!,
        versions: edited.versionHistory!.versions.map((version, index) =>
          index === 0 ? { ...version, label: "冲突的版本" } : version,
        ),
      },
    };
    expect(() => mergeWorkflowVersionHistory(edited, conflicting)).toThrow("无法覆盖");
    expect(JSON.stringify(edited)).toBe(before);
  });
});
