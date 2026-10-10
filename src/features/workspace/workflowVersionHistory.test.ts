import { describe, expect, it } from "vitest";
import {
  createKnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowCheckpoint,
  type KnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowNodeData,
  type KnowledgeVideoWorkflowPhase,
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
import { createReelbenchCheckpoint, createReelbenchOptions } from "./reelbenchWorkflowModel";
import { createMusicVideoCheckpoint, createMusicVideoOptions } from "./musicVideoWorkflowModel";
import {
  createProductSceneCheckpoint,
  createProductSceneOptions,
  generateProductScenePlan,
  productSceneInputSignature,
  type ProductSceneWorkflowOptions,
} from "./productSceneWorkflowModel";
import type { ReelbenchShotDraft } from "../../lib/reelbenchBackend";
import {
  initializeWorkflowVersions,
  mergeWorkflowVersionHistory,
  recordWorkflowVersion,
  redoWorkflowVersion,
  restoreWorkflowVersion,
  undoWorkflowVersion,
  workflowVersionContentSignature,
  workflowVersionStage,
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
const ACTIVE_PHASES = new Set<KnowledgeVideoWorkflowPhase>([
  "planning",
  "generating",
  "qc",
  "composing",
]);
/** 推进到某个生成阶段：版本链只在这种边界上封版建档。 */
function advance(
  value: KnowledgeVideoWorkflowConfig,
  phase: KnowledgeVideoWorkflowPhase,
  change: Partial<KnowledgeVideoWorkflowConfig> = {},
): KnowledgeVideoWorkflowConfig {
  const checkpoint: KnowledgeVideoWorkflowCheckpoint = change.checkpoint ?? value.checkpoint;
  return recordWorkflowVersion(value, {
    ...value,
    ...change,
    checkpoint: {
      ...checkpoint,
      phase,
      lastActivePhase: ACTIVE_PHASES.has(phase)
        ? (phase as "planning" | "generating" | "qc" | "composing")
        : value.checkpoint.lastActivePhase,
    },
  });
}
const versionsOf = (value: KnowledgeVideoWorkflowConfig) => value.versionHistory?.versions ?? [];
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

function reelbenchDraft(runId: string): ReelbenchShotDraft {
  return {
    runId,
    videoPath: "C:/source.mp4",
    outputDir: "C:/reelbench",
    sourceIdentity: { sizeBytes: 100, modifiedUnixMs: 1, sha256: "source-hash" },
    meta: { durationSeconds: 2, fps: 25, width: 640, height: 360, hasAudio: true },
    sceneThreshold: 0.3,
    minShotSeconds: 0.25,
    seedCuts: [0, 2],
    manualCuts: [],
    cast: [],
    trackPath: "C:/reelbench/track.json",
    sheets: [],
    shots: [
      {
        id: "S01",
        start: 0,
        end: 2,
        seconds: 2,
        motion: 0.1,
        size: "wide",
        category: "subject",
        camera: "static",
        transitionIn: "cut",
        subjects: ["人物"],
        frame: "人物在画面中央",
        onscreenText: "",
        audio: "",
        rhythm: "",
        rhythmNote: "",
        note: "",
        frameAPath: "C:/reelbench/a.jpg",
        frameBPath: "C:/reelbench/b.jpg",
      },
    ],
  };
}

describe("workflow configuration version history", () => {
  it("keeps MV acoustic evidence out of authored versions and clears it after restoring different inputs", () => {
    const base = config();
    const initial = initializeWorkflowVersions({
      ...base,
      musicVideo: { ...createMusicVideoOptions(), songPath: "C:/song.wav" },
      checkpoint: { ...base.checkpoint, musicVideo: createMusicVideoCheckpoint() },
    });
    const analyzed = recordWorkflowVersion(initial, {
      ...initial,
      checkpoint: {
        ...initial.checkpoint,
        musicVideo: {
          ...initial.checkpoint.musicVideo!,
          speech: {
            asr: {
              sourceSignature: "a".repeat(64),
              engine: "doubao-asr",
              modelVersion: "volc.bigasr.auc_turbo",
              transcript: "唱词",
              segments: [{ startSeconds: 1, endSeconds: 2, text: "唱词" }],
            },
          },
        },
      },
    });
    // 声学分析属于运行期证据，同一阶段内不产生版本。
    expect(analyzed.versionHistory?.versions).toHaveLength(1);
    const running = advance(analyzed, "generating");
    expect(running.versionHistory?.versions).toHaveLength(2);
    const edited = recordWorkflowVersion(running, {
      ...running,
      musicVideo: { ...running.musicVideo!, officialLyrics: "修订歌词" },
    });
    const restored = undoWorkflowVersion(edited);
    expect(restored.musicVideo?.officialLyrics).toBe("");
    expect(restored.checkpoint.musicVideo?.speech).toBeUndefined();
  });

  it("records one Reelbench annotation baseline and human edits, not progress or reports", () => {
    const initial = initializeWorkflowVersions({
      ...config(),
      reelbench: { ...createReelbenchOptions(), localVideoPath: "C:/source.mp4" },
      checkpoint: {
        ...config().checkpoint,
        runId: "run-1",
        reelbench: { ...createReelbenchCheckpoint(), videoPath: "C:/source.mp4" },
      },
    });
    const partial = advance(initial, "generating", {
      checkpoint: {
        ...initial.checkpoint,
        reelbench: { ...initial.checkpoint.reelbench!, draft: reelbenchDraft("run-1") },
      },
    });
    // 进入生成阶段：起始快照封版，草稿成型本身不再单独建档。
    expect(partial.versionHistory?.versions).toHaveLength(2);
    const generated = recordWorkflowVersion(partial, {
      ...partial,
      checkpoint: {
        ...partial.checkpoint,
        reelbench: { ...partial.checkpoint.reelbench!, completedDraftSignature: "generated-v1" },
      },
    });
    // 封版之后的第一笔同阶段改写派生一个工作副本，后续改写继续落在它身上。
    expect(generated.versionHistory?.versions).toHaveLength(3);
    const approved = recordWorkflowVersion(generated, {
      ...generated,
      checkpoint: {
        ...generated.checkpoint,
        phase: "done",
        finalPath: "C:/reelbench/report.html",
        reelbench: {
          ...generated.checkpoint.reelbench!,
          approvedDraftSignature: "generated-v1",
          reportHtmlPath: "C:/reelbench/report.html",
        },
      },
    });
    // 阶段推进（生成 → 完成）封存工作副本并新建完成版本。
    expect(approved.versionHistory?.versions).toHaveLength(4);
    const edited = recordWorkflowVersion(approved, {
      ...approved,
      checkpoint: {
        ...approved.checkpoint,
        reelbench: {
          ...approved.checkpoint.reelbench!,
          manualRevision: 1,
          draft: {
            ...approved.checkpoint.reelbench!.draft!,
            shots: [
              { ...approved.checkpoint.reelbench!.draft!.shots[0]!, frame: "重新标注的画面" },
            ],
          },
        },
      },
    });
    expect(edited.versionHistory?.versions).toHaveLength(5);
    const restored = undoWorkflowVersion(edited);
    expect(restored.checkpoint.reelbench?.draft?.shots[0]?.frame).toBe("人物在画面中央");
    expect(restored.checkpoint.reelbench?.validation).toBeNull();
    expect(restored.checkpoint.reelbench?.approvedDraftSignature).toBeNull();
    expect(restored.checkpoint.reelbench?.reportHtmlPath).toBeNull();
    expect(restored.checkpoint.reelbench?.step).toBe("validate");
    expect(restored.checkpoint.finalPath).toBeNull();
    expect(restored.checkpoint.phase).toBe("paused");
  });

  it("drops a restored Reelbench draft when its run identity differs", () => {
    const first = initializeWorkflowVersions({
      ...config(),
      reelbench: { ...createReelbenchOptions(), localVideoPath: "C:/source.mp4" },
      checkpoint: {
        ...config().checkpoint,
        phase: "generating",
        lastActivePhase: "generating",
        runId: "old-run",
        reelbench: {
          ...createReelbenchCheckpoint(),
          draft: reelbenchDraft("old-run"),
          completedDraftSignature: "old-complete",
          videoPath: "C:/source.mp4",
        },
      },
    });
    const later = advance(first, "qc", {
      historyRunId: "current-history",
      checkpoint: {
        ...first.checkpoint,
        runId: "new-run",
        reelbench: {
          ...first.checkpoint.reelbench!,
          draft: reelbenchDraft("new-run"),
          completedDraftSignature: "new-complete",
        },
      },
    });
    const restored = undoWorkflowVersion(later);
    expect(restored.checkpoint.reelbench?.draft).toBeNull();
    expect(restored.checkpoint.reelbench?.videoPath).toBeNull();
    expect(restored.checkpoint.runId).toBeNull();
    expect(restored.checkpoint.reelbench?.step).toBe("source");
    expect(restored.historyRunId).toBeUndefined();
    expect(restored.executionPlan?.executionIntent).toBe("restart");
  });

  it("starts a fresh Reelbench run after restoring different source options", () => {
    const original = initializeWorkflowVersions({
      ...config(),
      reelbench: { ...createReelbenchOptions(), localVideoPath: "C:/source.mp4" },
      historyRunId: "old-history",
      checkpoint: {
        ...config().checkpoint,
        phase: "generating",
        lastActivePhase: "generating",
        runId: "old-run",
        reelbench: {
          ...createReelbenchCheckpoint(),
          videoPath: "C:/source.mp4",
          draft: reelbenchDraft("old-run"),
          completedDraftSignature: "old-complete",
        },
      },
    });
    const changed = advance(original, "qc", {
      reelbench: { ...original.reelbench!, localVideoPath: "C:/replacement.mp4" },
      historyRunId: "new-history",
    });
    const restored = undoWorkflowVersion(changed);
    expect(restored.reelbench?.localVideoPath).toBe("C:/source.mp4");
    expect(restored.checkpoint.runId).toBeNull();
    expect(restored.checkpoint.reelbench).toEqual(createReelbenchCheckpoint());
    expect(restored.historyRunId).toBeUndefined();
    expect(restored.executionPlan?.executionIntent).toBe("restart");
  });

  it("retains unlimited immutable branches through JSON reload and targeted redo", () => {
    // 每一轮都在推进/回退一个生成阶段，所以每次循环恰好封一个版本，且数量不受裁剪。
    const cycle: readonly KnowledgeVideoWorkflowPhase[] = [
      "planning",
      "generating",
      "qc",
      "composing",
      "done",
    ];
    let current = initializeWorkflowVersions(config());
    expect(initializeWorkflowVersions(current)).toBe(current);
    for (let index = 1; index <= 205; index += 1)
      current = advance(current, cycle[(index - 1) % cycle.length]!, { brief: `主题 ${index}` });
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
    // 计划出现就是一个生成阶段边界：初始草稿封版，计划自成一个版本。
    const planned = recordWorkflowVersion(initial, { ...initial, executionPlan: plan });
    expect(planned.versionHistory?.versions).toHaveLength(2);
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
        phase: "planning",
        lastActivePhase: "planning",
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
    // 任务身份、审批、注入的画布文本与进度停留在同一阶段，不产生版本。
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
    expect(received.versionHistory?.versions).toHaveLength(2);
    expect(received.versionHistory?.currentVersionId).toBe(
      recorded.versionHistory?.currentVersionId,
    );
    const undone = recordWorkflowVersion(received, undoWorkflowVersion(received));
    expect(undone.versionHistory?.versions).toHaveLength(2);
    expect(undone.checkpoint.script).toBe("");
    const redone = recordWorkflowVersion(undone, redoWorkflowVersion(undone));
    expect(redone.versionHistory?.versions).toHaveLength(2);
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
        phase: "generating",
        lastActivePhase: "generating",
        shots: [shot],
        executionPlan: approved,
        mediaApprovals: { composition: { signature: "media", approvedAt: 1 } },
      },
    });
    const edited = advance(initial, "qc", {
      checkpoint: { ...initial.checkpoint, shots: [{ ...shot, videoPrompt: "新镜头提示" }] },
    });
    const running = advance(edited, "done", {
      historyRunId: "history-latest",
      checkpoint: {
        ...edited.checkpoint,
        runId: "run-latest",
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
    const restored = restoreWorkflowVersion(running, initial.versionHistory!.currentVersionId);
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
      checkpoint: { ...config().checkpoint, phase: "generating", lastActivePhase: "generating" },
    });
    const removedText = advance(initial, "qc", { connectedTexts: [] });
    const removedMedia = advance(removedText, "composing", { connectedMaterials: [] });
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
    const authored = advance(initial, "generating", {
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
    const finished = advance(authored, "done", {
      checkpoint: {
        ...authored.checkpoint,
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
    const restored = restoreWorkflowVersion(finished, initial.versionHistory!.currentVersionId);
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
    expect(restored.versionHistory?.versions).toHaveLength(3);
    expect(JSON.stringify(restored).match(/"versionHistory"/g)).toHaveLength(1);
    const reconciled = recordWorkflowVersion(finished, restored);
    expect(reconciled.versionHistory?.versions).toHaveLength(3);
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
    const edited = advance(initial, "generating", { brief: "新的主题" });
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
    const first = advance(initial, "generating", { brief: "第一稿" });
    const second = advance(first, "qc", { brief: "第二稿" });
    const firstAgain = mergeWorkflowVersionHistory(second, first);
    expect(firstAgain.brief).toBe("第一稿");
    expect(firstAgain.versionHistory?.versions).toHaveLength(3);
    const sibling = advance(firstAgain, "composing", { brief: "另一条分支" });
    const latest = recordWorkflowVersion(sibling, {
      ...sibling,
      checkpoint: { ...sibling.checkpoint, runId: "paid-run" },
    });
    const unchangedContent = mergeWorkflowVersionHistory(latest, sibling);
    expect(unchangedContent.checkpoint.runId).toBe("paid-run");
    expect(unchangedContent.checkpoint.phase).toBe("composing");
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
    // 阶段推进后父版本已封版：封版内容必须逐字一致，不允许静默覆盖。
    const edited = advance(original, "generating", { brief: "新主题" });
    const sealed = edited.versionHistory!.versions[0]!;
    expect(sealed.open).toBeUndefined();
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
        versions: edited.versionHistory!.versions.map((version) =>
          version.id === sealed.id ? { ...version, label: "冲突的版本" } : version,
        ),
      },
    };
    expect(() => mergeWorkflowVersionHistory(edited, conflicting)).toThrow("无法覆盖");
    expect(JSON.stringify(edited)).toBe(before);
  });

  describe("generation-stage versions", () => {
    it("folds parameter and mode changes into the current version instead of appending one per edit", () => {
      let current = initializeWorkflowVersions(config());
      const initialId = current.versionHistory!.currentVersionId;
      const intents = ["快速", "精细", "快速", "精细", "快速"];
      for (const [index, intent] of intents.entries()) {
        current = recordWorkflowVersion(current, {
          ...current,
          brief: `主题 ${index}`,
          catalogResolved: index % 2 === 0,
          imageParameterValues: { quality: intent },
          models: {
            ...current.models,
            image: { providerId: "p", modelDefinitionId: `image-${intent}` },
          },
          checkpoint: {
            ...current.checkpoint,
            // 参数变化让本地计划重新排布：阶段没变，仍然只是一个版本。
            planRevision: 0,
            updatedAt: 100 + index,
          },
        });
      }
      const versions = versionsOf(current);
      expect(versions).toHaveLength(1);
      expect(versions[0]!.id).toBe(initialId);
      expect(versions[0]!.open).toBe(true);
      expect(versions[0]!.updatedAt).toBeGreaterThanOrEqual(versions[0]!.createdAt);
      const snapshot = versions[0]!.config;
      expect(snapshot.brief).toBe("主题 4");
      expect(snapshot.models.image.modelDefinitionId).toBe("image-快速");
      expect(workflowVersionContentSignature(snapshot)).toBe(
        workflowVersionContentSignature(current),
      );
      expect(workflowVersionState(current).canUndo).toBe(false);
    });

    it("seals one version per generation stage and labels each stage", () => {
      let current = initializeWorkflowVersions(config());
      current = advance(current, "planning", {
        checkpoint: { ...current.checkpoint, script: "计划稿" },
      });
      current = advance(current, "generating", {
        checkpoint: { ...current.checkpoint, shots: [shot] },
      });
      current = advance(current, "qc");
      current = advance(current, "composing");
      current = advance(current, "done", {
        checkpoint: { ...current.checkpoint, finalPath: "C:/final.mp4" },
      });
      const versions = versionsOf(current);
      expect(workflowVersionStage(current)).toBe("done");
      expect(versions.map((version) => version.label)).toEqual([
        "初始版本",
        "已生成计划",
        "生成阶段",
        "质检阶段",
        "合成阶段",
        "制作完成",
      ]);
      expect(versions.every((version) => version.open === undefined)).toBe(true);
      expect(versions[1]!.config.checkpoint.script).toBe("计划稿");
      expect(versions[2]!.config.checkpoint.shots).toHaveLength(1);
      expect(versions[5]!.config.checkpoint.finalPath).toBe("C:/final.mp4");
      // 回退一步就是回到上一个生成阶段的起点，而不是回到某个中间参数。
      const back = undoWorkflowVersion(current);
      expect(workflowVersionState(back).currentVersionId).toBe(versions[4]!.id);
      expect(versionsOf(back)).toHaveLength(6);
    });

    it("keeps a finished attempt when inputs change and the stage falls back", () => {
      let current = initializeWorkflowVersions(config());
      current = advance(current, "generating", {
        checkpoint: { ...current.checkpoint, shots: [shot] },
      });
      current = advance(current, "done", {
        checkpoint: { ...current.checkpoint, finalPath: "C:/done.mp4" },
      });
      const finished = versionsOf(current);
      expect(finished).toHaveLength(3);
      // 改一个参数让成果作废：已完成的阶段必须留档，并新开一个当前版本。
      current = recordWorkflowVersion(current, {
        ...current,
        brief: "换成新主题",
        checkpoint: { ...current.checkpoint, phase: "idle", lastActivePhase: null, shots: [] },
      });
      expect(versionsOf(current)).toHaveLength(4);
      expect(workflowVersionStage(current)).toBe("draft");
      expect(versionsOf(current)[2]!.config.checkpoint.finalPath).toBe("C:/done.mp4");
      const restoredFinished = restoreWorkflowVersion(current, finished[2]!.id);
      expect(restoredFinished.brief).toBe("原始主题");
      expect(restoredFinished.executionPlan?.executionIntent).toBe("restart");
    });

    it("derives a single working copy after a sealed version and keeps rewriting it", () => {
      let current = initializeWorkflowVersions(config());
      current = advance(current, "generating", { brief: "第一稿" });
      expect(versionsOf(current)).toHaveLength(2);
      current = edit(current, "第二稿");
      expect(versionsOf(current)).toHaveLength(3);
      expect(versionsOf(current)[2]!.open).toBe(true);
      current = edit(current, "第三稿");
      current = edit(current, "第四稿");
      expect(versionsOf(current)).toHaveLength(3);
      expect(versionsOf(current)[2]!.config.brief).toBe("第四稿");
      // 回退后继续编辑会建立分支，原有阶段版本始终保持原样。
      const branchRoot = versionsOf(current)[1]!;
      const branched = edit(undoWorkflowVersion(current), "另一条分支");
      expect(versionsOf(branched)).toHaveLength(4);
      expect(branchRoot.config.brief).toBe("第一稿");
      expect(branched.versionHistory?.preferredChildByVersion[branchRoot.id]).toBeDefined();
    });

    it("reconciles divergent working copies but never rewrites sealed versions", () => {
      const initial = initializeWorkflowVersions(config());
      const running = advance(initial, "generating", { brief: "执行稿" });
      const first = edit(running, "草稿甲");
      const later = edit(first, "草稿乙");
      // 画布旧快照与最新副本同名不同内容：以正在生效的这一份为准，不报冲突。
      const reconciled = mergeWorkflowVersionHistory(later, first);
      expect(reconciled.brief).toBe("草稿甲");
      expect(versionsOf(reconciled)).toHaveLength(3);
      expect(versionsOf(reconciled)[2]!.config.brief).toBe("草稿甲");
      expect(versionsOf(reconciled)[0]!.config.brief).toBe("原始主题");
    });

    it("rebuilds a product-scene plan on parameter and mode changes inside one version", () => {
      const withPlan = (overrides: Partial<ProductSceneWorkflowOptions>) => {
        const productScene = {
          ...createProductSceneOptions(),
          totalCount: 8,
          batchSize: 2,
          views: [
            {
              id: "front",
              label: "机身原图",
              sourcePath: "C:/product/front.png",
              preparedPath: "C:/product/prepared.png",
              contentHash: "a".repeat(64),
              angle: "front45" as const,
              approved: true,
            },
          ],
          ...overrides,
        };
        const value = { ...config(), productScene };
        return {
          ...value,
          checkpoint: {
            ...value.checkpoint,
            phase: "awaiting_approval" as const,
            productScene: {
              ...createProductSceneCheckpoint(),
              inputSignature: productSceneInputSignature(value),
              rows: generateProductScenePlan(productScene),
            },
          },
        };
      };
      let current = initializeWorkflowVersions(withPlan({ generationMode: "reference" }));
      expect(versionsOf(current)).toHaveLength(1);
      expect(versionsOf(current)[0]!.config.checkpoint.productScene!.rows).toHaveLength(8);
      for (const override of [
        { generationMode: "composite" as const },
        { generationMode: "reference" as const, aspectRatio: "9:16" as const },
        { generationMode: "reference" as const, sceneBias: "geek" as const, totalCount: 12 },
        { generationMode: "composite" as const, productScale: 0.62, totalCount: 12 },
      ])
        current = recordWorkflowVersion(current, withPlan(override));
      // 反复切模式/改参数会重建本地计划，但仍在同一生成阶段：只保留一个当前版本。
      const versions = versionsOf(current);
      expect(versions).toHaveLength(1);
      expect(versions[0]!.config.checkpoint.productScene!.rows).toHaveLength(12);
      expect(versions[0]!.config.checkpoint.productScene!.rows.map((row) => row.recipe)).toEqual(
        current.checkpoint.productScene!.rows.map((row) => row.recipe),
      );
      expect(versions[0]!.config.productScene!.generationMode).toBe("composite");
      expect(versions[0]!.open).toBe(true);
    });
  });
});
