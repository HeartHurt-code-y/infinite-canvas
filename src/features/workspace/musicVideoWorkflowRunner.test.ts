import { describe, expect, it, vi } from "vitest";
import type {
  OptimizeVideoPromptCommand,
  ProviderCatalogEntry,
  VideoCompositionJobRecord,
} from "../../lib/backend";
import type { MvMediaClient, MvSongProbe } from "../../lib/mvMedia";
import { modelParameterCapabilities } from "../../lib/modelCapabilities";
import { catalog, fakeDependencies, node } from "../../test/videoWorkflowFixtures";
import {
  approveWorkflowExecutionPlan,
  createWorkflowExecutionPlan,
  getWorkflowExecutionPlan,
} from "./workflowExecutionPlan";
import {
  createMusicVideoOptions,
  createMusicVideoCheckpoint,
  musicVideoDeliveryBundle,
  MUSIC_VIDEO_APPROVAL,
  patchMusicVideoArtifact,
  setMusicVideoLipReview,
  type MusicVideoShot,
  type MusicVideoStage,
  type MusicVideoTimelineSegment,
} from "./musicVideoWorkflowModel";
import {
  createMusicVideoWorkflowRunner,
  musicVideoGenerationDuration,
  parseMusicVideoLrc,
  parseMusicVideoStage,
  validateMusicVideoTimeline,
} from "./musicVideoWorkflowRunner";
import type { KnowledgeVideoWorkflowNodeData } from "./workspaceModel";

const song: MvSongProbe = {
  sourcePath: "C:\\music\\song.wav",
  sourceSignature: "a".repeat(64),
  durationSeconds: 8,
};
const timeline: readonly MusicVideoTimelineSegment[] = [
  {
    id: "segment-1",
    startSeconds: 0,
    endSeconds: 4,
    kind: "vocal",
    text: "完整一句歌词",
    section: "主歌",
  },
  {
    id: "segment-2",
    startSeconds: 4,
    endSeconds: 8,
    kind: "instrumental",
    text: "",
    section: "尾奏",
  },
];
const shots: readonly MusicVideoShot[] = timeline.map((segment, index) => ({
  id: `shot-${index + 1}`,
  segmentId: segment.id,
  title: "音乐分镜",
  startSeconds: segment.startSeconds,
  endSeconds: segment.endSeconds,
  durationSeconds: 4,
  framing: "medium",
  lipSync: "none",
  visual: "抽象光影画面",
  videoPrompt: "随节拍变化的光影",
  referenceAssetIds: [],
}));
const duration = modelParameterCapabilities(
  catalog[0]!.models[2]!.operationSchema,
  "video_generation",
  "project-video",
).find((item) => item.key === "duration")!;
function stageOutput(stage: MusicVideoStage, sequence: readonly MusicVideoShot[] = shots) {
  return {
    schemaVersion: "music-video-stage.v1",
    stage,
    status: "ready",
    decision: null,
    content: `完整${stage}文档`,
    inputSummary: "用户歌曲和已确认前序稿",
    timeline: stage === "timeline" ? timeline : [],
    style: stage === "style" ? { description: "抽象光影", assets: [] } : null,
    shots: ["storyboard", "prompts"].includes(stage) ? sequence : [],
  };
}
function approved(source: KnowledgeVideoWorkflowNodeData): KnowledgeVideoWorkflowNodeData {
  const plan = getWorkflowExecutionPlan(source) ?? createWorkflowExecutionPlan(source);
  const approval = approveWorkflowExecutionPlan(plan, source);
  return {
    ...source,
    config: {
      ...source.config,
      executionPlan: approval,
      checkpoint: { ...source.config.checkpoint, executionPlan: approval },
    },
  };
}
function setup(
  options: {
    documents?: boolean;
    segments?: readonly MusicVideoShot[];
    songDuration?: number;
    sync?: boolean;
    audioProfile?: boolean;
    noLrc?: boolean;
  } = {},
) {
  const fake = fakeDependencies("");
  const sequence =
    options.segments ??
    (options.sync
      ? shots.map((shot, index) => ({
          ...shot,
          lipSync: index === 0 ? ("sync" as const) : ("none" as const),
          referenceAssetIds: index === 0 ? ["singer"] : [],
        }))
      : shots);
  const source = node();
  let current: KnowledgeVideoWorkflowNodeData = {
    ...source,
    config: {
      ...source.config,
      musicVideo: {
        ...createMusicVideoOptions(),
        songPath: song.sourcePath,
        songName: "真实歌曲.wav",
        speechProviderConnectionId: "project-voice",
        lrc: options.noLrc ? "" : "[00:00.00]完整一句歌词\n[00:04.00][Instrumental]",
        characterMode: options.sync ? "generate" : "none",
        deliverable: options.documents ? "documents" : "video",
      },
    },
  };
  const songProbe = { ...song, durationSeconds: options.songDuration ?? song.durationSeconds };
  const media = {
    probeSong: vi.fn<MvMediaClient["probeSong"]>(() => Promise.resolve(songProbe)),
    prepareAudioWindow: vi.fn<MvMediaClient["prepareAudioWindow"]>(
      (_path, sourceSignature, window) =>
        Promise.resolve({
          path: `C:\\audio\\${window.id}.wav`,
          sourceSignature,
          window,
          durationSeconds: window.endSeconds - window.startSeconds,
          mimeType: "audio/wav",
        }),
    ),
    startComposition: vi.fn<MvMediaClient["startComposition"]>(() =>
      Promise.resolve({
        jobId: "mv-composition",
        status: "processing",
        progress: 0,
        finalPath: null,
        fileName: null,
        width: null,
        height: null,
        durationSeconds: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
      } satisfies VideoCompositionJobRecord),
    ),
    checkAlignment: vi.fn<MvMediaClient["checkAlignment"]>(() =>
      Promise.resolve({
        audioDurationSeconds: songProbe.durationSeconds,
        videoDurationSeconds: songProbe.durationSeconds,
        differenceSeconds: 0,
        toleranceSeconds: 0.06,
        aligned: true,
      }),
    ),
    clipSignature: vi.fn<MvMediaClient["clipSignature"]>(() => Promise.resolve("c".repeat(64))),
    transcribeSong: vi.fn<MvMediaClient["transcribeSong"]>(() =>
      Promise.resolve({
        sourceSignature: songProbe.sourceSignature,
        engine: "measured-asr",
        modelVersion: "test-1",
        transcript: "完整一句歌词",
        segments: [{ startSeconds: 0, endSeconds: 4, text: "完整一句歌词", confidence: 0.9 }],
      }),
    ),
    alignLyrics: vi.fn<MvMediaClient["alignLyrics"]>((_path, _signature, lyrics) =>
      Promise.resolve({
        sourceSignature: songProbe.sourceSignature,
        engine: "measured-aligner",
        modelVersion: "test-1",
        lyrics,
        lines: [{ startSeconds: 0, endSeconds: 4, text: lyrics, confidence: 0.9 }],
        unmatchedLyrics: [],
      }),
    ),
  } satisfies MvMediaClient;
  vi.mocked(fake.promptClient.run).mockImplementation((command: OptimizeVideoPromptCommand) => {
    let output: unknown = { result: "PASS", report: "结构检查通过；实际时间与口型仍需人工试听" };
    const stage = command.mode.replace("music_video_", "") as MusicVideoStage;
    if (["timeline", "style", "storyboard", "prompts"].includes(stage)) {
      output = stageOutput(stage, sequence);
      if (stage === "style" && options.sync)
        output = {
          ...stageOutput(stage, sequence),
          style: {
            description: "固定人物演唱",
            assets: [{ id: "singer", kind: "character", name: "演唱者", prompt: "稳定人物形象" }],
          },
        };
    }
    const json = JSON.stringify(output);
    return Promise.resolve({ optimizedPrompt: json, rawModelOutput: json });
  });
  const configuredCatalog: readonly ProviderCatalogEntry[] = options.audioProfile
    ? catalog.map((provider) => ({
        ...provider,
        models: provider.models.map((model) =>
          model.definitionId === "project-video"
            ? {
                ...model,
                operationSchema: {
                  video_generation: {
                    ...(model.operationSchema["video_generation"] as Record<string, unknown>),
                    request: { mediaEncoding: "wan_media_array" },
                  },
                },
              }
            : model,
        ),
      }))
    : catalog;
  const providerCatalog: readonly ProviderCatalogEntry[] = [
    ...configuredCatalog,
    {
      provider: {
        ...catalog[0]!.provider,
        id: "project-voice",
        adapterId: "doubao_voice_v1",
        displayName: "豆包语音",
      },
      models: [],
    },
  ];
  const runner = createMusicVideoWorkflowRunner({
    promptClient: fake.promptClient,
    generationClient: fake.generation,
    frameClient: fake.frames,
    composerClient: fake.composer,
    mvMediaClient: media,
    now: () => 123,
    createId: () => "mv-run",
    sleep: () => Promise.resolve(),
  });
  async function run(decisionResolution?: string) {
    const checkpoint = await runner.run({
      node: current,
      providerCatalog,
      resume: current.config.checkpoint.runId != null,
      ...(decisionResolution ? { decisionResolution } : {}),
      signal: new AbortController().signal,
      onCheckpoint: (checkpoint) => {
        current = { ...current, config: { ...current.config, checkpoint } };
      },
      onProgress: vi.fn(),
    });
    return checkpoint;
  }
  async function planAll() {
    current = approved(current);
    await run();
    for (let index = 0; index < 4; index += 1) await run(MUSIC_VIDEO_APPROVAL);
    return current.config.checkpoint;
  }
  return {
    fake,
    media,
    runner,
    providerCatalog,
    run,
    planAll,
    get: () => current,
    set: (value: KnowledgeVideoWorkflowNodeData) => {
      current = value;
    },
    reviewLip: (decision: "approved" | "rejected" = "approved") => {
      current = {
        ...current,
        config: {
          ...current.config,
          checkpoint: setMusicVideoLipReview(
            current.config.checkpoint,
            "shot-1",
            decision,
            "c".repeat(64),
          ),
        },
      };
    },
    approve: () => {
      current = approved(current);
    },
  };
}

describe("MV time windows and authoring validation", () => {
  it("exports rounded LRC timestamps with proper minute carry while preserving precise JSON windows", () => {
    const precise = [{ ...timeline[0]!, startSeconds: 59.999, endSeconds: 64 }];
    const files = musicVideoDeliveryBundle({
      ...node().config.checkpoint,
      musicVideo: {
        ...createMusicVideoCheckpoint(),
        stages: {
          timeline: {
            artifact: {
              version: 1,
              createdAt: 1,
              content: "歌词",
              inputSummary: "原始时间",
              timeline: precise,
            },
            review: null,
            history: [],
          },
        },
      },
    });
    expect(files.find((item) => item.fileName.endsWith(".lrc"))?.content).toBe(
      "[01:00.00]完整一句歌词",
    );
    expect(files.find((item) => item.fileName.endsWith(".json"))?.content).toContain("59.999");
  });
  it("retains repeated complete LRC lines, offset, intro and instrumental tail without inventing splits", () => {
    const parsed = parseMusicVideoLrc(
      "[offset:500]\n[00:01.00][00:03.00]重复的完整一句\n[00:05.00][Instrumental]",
      8,
    );
    expect(
      parsed.map((segment) => [
        segment.startSeconds,
        segment.endSeconds,
        segment.kind,
        segment.text,
      ]),
    ).toEqual([
      [0, 1.5, "instrumental", ""],
      [1.5, 3.5, "vocal", "重复的完整一句"],
      [3.5, 5.5, "vocal", "重复的完整一句"],
      [5.5, 8, "instrumental", ""],
    ]);
    validateMusicVideoTimeline(parsed, song);
    expect(() => parseMusicVideoLrc("[offset:-1000]\n[00:00.50]越界", 8)).toThrow("超出");
    expect(() =>
      validateMusicVideoTimeline([{ ...timeline[0]!, endSeconds: 3 }, timeline[1]!], song),
    ).toThrow("空隙");
    expect(() => musicVideoGenerationDuration(7.5, duration)).toThrow("不会乱拆歌词");
    expect(musicVideoGenerationDuration(4.3, duration)).toBe(5);
  });
  it("rejects altered approved windows, unsupported durations, no-character sync and wide sync", () => {
    const context = { options: createMusicVideoOptions(), song, timeline, duration };
    const parse = (patch: Partial<MusicVideoShot>, characterMode: "none" | "generate" = "none") =>
      parseMusicVideoStage(
        JSON.stringify(stageOutput("storyboard", [{ ...shots[0]!, ...patch }, shots[1]!])),
        "storyboard",
        { ...context, options: { ...context.options, characterMode } },
      );
    expect(() => parse({ startSeconds: 0.2 })).toThrow("音乐窗口");
    expect(() => parse({ durationSeconds: 4.2 })).toThrow("合法时长");
    expect(() => parse({ lipSync: "sync" })).toThrow("对口型镜头");
    expect(() => parse({ lipSync: "sync", framing: "wide" }, "generate")).toThrow("对口型镜头");
    expect(() =>
      parseMusicVideoStage(JSON.stringify(stageOutput("timeline")), "style", context),
    ).toThrow("越过");
  });
});

describe("MV human-reviewed production", () => {
  it("rejects zero-frame music windows before text or video paid calls", async () => {
    const flow = setup();
    flow.media.alignLyrics.mockImplementationOnce((_path, sourceSignature, lyrics) =>
      Promise.resolve({
        sourceSignature,
        engine: "measured-aligner",
        modelVersion: "test-1",
        lyrics,
        lines: [
          { startSeconds: 0, endSeconds: 0.01, text: "过短的完整行", confidence: 0.9 },
          { startSeconds: 0.01, endSeconds: 4, text: "下一行", confidence: 0.9 },
        ],
        unmatchedLyrics: [],
      }),
    );
    const source = flow.get();
    flow.set({
      ...source,
      config: {
        ...source.config,
        musicVideo: {
          ...source.config.musicVideo!,
          lrc: "[00:00.00]过短的完整行\n[00:00.01]下一行\n[00:04.00][Instrumental]",
        },
      },
    });
    flow.approve();
    const result = await flow.run();
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("不足一个 30fps 输出帧");
    expect(flow.fake.promptClient.run).not.toHaveBeenCalled();
    expect(flow.fake.generation.start).not.toHaveBeenCalled();
  });

  it("retries an initially failed song probe but rejects unidentified checkpoints containing old media", async () => {
    const flow = setup({ documents: true });
    flow.approve();
    flow.media.probeSong.mockRejectedValueOnce(new Error("本地歌曲暂时不可读"));
    const failed = await flow.run();
    expect(failed.phase).toBe("failed");
    expect(failed.runId).toBe("mv-run");
    expect(failed.musicVideo?.song).toBeNull();
    const retried = await flow.run();
    expect(retried.musicVideo?.pending?.stage).toBe("timeline");
    expect(retried.musicVideo?.song?.sourceSignature).toBe(song.sourceSignature);
    expect(flow.media.probeSong).toHaveBeenCalledTimes(2);
    expect(flow.fake.generation.start).not.toHaveBeenCalled();
    const current = flow.get();
    flow.set({
      ...current,
      config: {
        ...current.config,
        checkpoint: {
          ...failed,
          shotRuns: {
            old: {
              shotId: "old",
              videoTaskId: "paid-old-song",
              qcStatus: "pending",
              retryCount: 0,
            },
          },
        },
      },
    });
    const rejected = await flow.run();
    expect(rejected.error).toContain("避免复用旧内容");
    expect(flow.media.probeSong).toHaveBeenCalledTimes(2);
  });
  it("requires initial and every stage approval, never auto-approves resume, and completes documents without media tasks", async () => {
    const flow = setup({ documents: true });
    expect((await flow.run()).phase).toBe("awaiting_approval");
    expect(flow.fake.promptClient.run).not.toHaveBeenCalled();
    expect(flow.media.probeSong).not.toHaveBeenCalled();
    flow.approve();
    expect((await flow.run()).musicVideo?.pending?.stage).toBe("timeline");
    const calls = vi.mocked(flow.fake.promptClient.run).mock.calls.length;
    expect((await flow.run()).musicVideo?.pending?.stage).toBe("timeline");
    expect(flow.fake.promptClient.run).toHaveBeenCalledTimes(calls);
    for (const stage of ["style", "storyboard", "prompts"])
      expect((await flow.run(MUSIC_VIDEO_APPROVAL)).musicVideo?.pending?.stage).toBe(stage);
    const result = await flow.run(MUSIC_VIDEO_APPROVAL);
    expect(result.phase).toBe("done");
    expect(result.shots).toHaveLength(2);
    expect(flow.fake.generation.start).not.toHaveBeenCalled();
    expect(flow.media.startComposition).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(flow.fake.promptClient.run)
        .mock.calls.every(
          ([input]) => !input.multimodalInputs?.some((item) => item.kind === "audio"),
        ),
    ).toBe(true);
  });
  it("uses dedicated ASR and forced alignment without asking a text model to invent timestamps", async () => {
    const flow = setup({ documents: true, noLrc: true });
    flow.approve();
    const result = await flow.run();
    expect(result.musicVideo?.pending?.stage).toBe("timeline");
    expect(flow.media.transcribeSong).toHaveBeenCalledWith(
      song.sourcePath,
      song.sourceSignature,
      "project-voice",
    );
    expect(flow.media.alignLyrics).toHaveBeenCalledWith(
      song.sourcePath,
      song.sourceSignature,
      "完整一句歌词",
      "project-voice",
    );
    const commands = vi.mocked(flow.fake.promptClient.run).mock.calls.map(([input]) => input);
    expect(commands.map((input) => input.mode)).toEqual(["music_video_review"]);
    expect(
      commands.every(
        (input) =>
          !input.multimodalInputs?.some(
            (item) => item.localPath === song.sourcePath && item.kind === "audio",
          ),
      ),
    ).toBe(true);
  });
  it("keeps legacy document-only LRC usable without claiming automatic acoustic validation", async () => {
    const flow = setup({ documents: true });
    const source = flow.get();
    flow.set({
      ...source,
      config: {
        ...source.config,
        musicVideo: { ...source.config.musicVideo!, speechAnalysisMode: "manual" },
      },
    });
    flow.approve();
    const result = await flow.run();
    expect(result.musicVideo?.pending?.stage).toBe("timeline");
    expect(result.musicVideo?.stages.timeline?.artifact?.inputSummary).toContain(
      "未执行声学强制对齐",
    );
    expect(flow.media.transcribeSong).not.toHaveBeenCalled();
    expect(flow.media.alignLyrics).not.toHaveBeenCalled();
  });
  it("blocks missing ASR before text or media calls and reuses measured ASR after alignment retry", async () => {
    const flow = setup();
    flow.approve();
    flow.media.transcribeSong.mockRejectedValueOnce(new Error("项目供应商未配置语音识别模型"));
    const missing = await flow.run();
    expect(missing.phase).toBe("failed");
    expect(missing.error).toContain("未配置语音识别模型");
    expect(flow.fake.promptClient.run).not.toHaveBeenCalled();
    expect(flow.fake.generation.start).not.toHaveBeenCalled();
    flow.media.alignLyrics.mockRejectedValueOnce(new Error("强制对齐暂不可用"));
    const interrupted = await flow.run();
    expect(interrupted.phase).toBe("failed");
    expect(interrupted.musicVideo?.speech?.asr?.engine).toBe("measured-asr");
    const resumed = await flow.run();
    expect(resumed.musicVideo?.pending?.stage).toBe("timeline");
    expect(flow.media.transcribeSong).toHaveBeenCalledTimes(2);
    expect(flow.media.alignLyrics).toHaveBeenCalledTimes(2);
  });
  it("blocks media before unsupported audio-reference sync and detects same-path song replacement", async () => {
    const flow = setup({ sync: true });
    const plan = await flow.planAll();
    expect(plan.phase).toBe("failed");
    expect(plan.error).toContain("不支持参考音频");
    expect(flow.fake.generation.start).not.toHaveBeenCalled();
    vi.mocked(flow.media.probeSong).mockResolvedValueOnce({
      ...song,
      sourceSignature: "b".repeat(64),
    });
    expect((await flow.run()).error).toContain("正文或时长已改变");
    expect(flow.fake.generation.start).not.toHaveBeenCalled();
  });
  it("gates the pilot before batch generation, attaches only sync audio, reuses tasks, and requires final approval", async () => {
    const flow = setup({ sync: true, audioProfile: true });
    expect((await flow.planAll()).executionPlan?.scope).toBe("delivery");
    flow.approve();
    expect((await flow.run()).executionPlan?.review?.kind).toBe("assets");
    flow.approve();
    const pilot = await flow.run();
    expect(pilot.executionPlan?.review?.kind).toBe("first_shot");
    expect(
      vi
        .mocked(flow.fake.generation.start)
        .mock.calls.filter(([input]) => input.operation === "video_generation"),
    ).toHaveLength(1);
    const command = vi
      .mocked(flow.fake.generation.start)
      .mock.calls.find(([input]) => input.operation === "video_generation")?.[0];
    expect(command?.explicitMedia).toContainEqual(
      expect.objectContaining({
        role: "reference_audio",
        target: { kind: "local_file", path: "C:\\audio\\shot-1.wav", mediaType: "audio" },
      }),
    );
    flow.approve();
    expect((await flow.run()).executionPlan?.review?.kind).toBe("composition");
    expect(flow.media.prepareAudioWindow).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(flow.fake.generation.start)
        .mock.calls.filter(([input]) => input.operation === "video_generation"),
    ).toHaveLength(2);
    flow.reviewLip();
    flow.approve();
    expect((await flow.run()).executionPlan?.review?.kind).toBe("final");
    expect(flow.media.startComposition).toHaveBeenCalledTimes(1);
    expect(flow.media.startComposition).toHaveBeenCalledWith(
      expect.objectContaining({
        songPath: song.sourcePath,
        sourceSignature: song.sourceSignature,
        windows: [
          expect.objectContaining({ startSeconds: 0, endSeconds: 4 }),
          expect.objectContaining({ startSeconds: 4, endSeconds: 8 }),
        ],
      }),
    );
    expect(flow.fake.composer.startComposition).not.toHaveBeenCalled();
    flow.approve();
    expect((await flow.run()).phase).toBe("done");
    expect(flow.media.startComposition).toHaveBeenCalledTimes(1);
    expect(flow.media.checkAlignment).toHaveBeenCalledWith(expect.any(String), 8);
    expect(flow.media.clipSignature).toHaveBeenCalledTimes(3);
    expect(flow.get().config.checkpoint.musicVideo?.lipReviews?.["shot-1"]?.decision).toBe(
      "approved",
    );
  });
  it("blocks composition until every sync clip is explicitly reviewed, including rejected clips", async () => {
    const flow = setup({ sync: true, audioProfile: true });
    await flow.planAll();
    for (const kind of ["assets", "first_shot", "composition"]) {
      flow.approve();
      expect((await flow.run()).executionPlan?.review?.kind).toBe(kind);
    }
    flow.approve();
    const blocked = await flow.run();
    expect(blocked.phase).toBe("failed");
    expect(blocked.error).toContain("尚未人工选用");
    expect(flow.media.startComposition).not.toHaveBeenCalled();
    flow.reviewLip("rejected");
    expect((await flow.run()).error).toContain("尚未人工选用");
    flow.reviewLip("approved");
    const composed = await flow.run();
    expect(composed.executionPlan?.review?.kind).toBe("final");
    expect(flow.media.startComposition).toHaveBeenCalledTimes(1);
  });
  it("invalidates a human lip review when the clip bytes change at the same path", async () => {
    const flow = setup({ sync: true, audioProfile: true });
    await flow.planAll();
    for (let index = 0; index < 3; index += 1) {
      flow.approve();
      await flow.run();
    }
    flow.reviewLip();
    flow.media.clipSignature.mockResolvedValueOnce("d".repeat(64));
    flow.approve();
    const blocked = await flow.run();
    expect(blocked.phase).toBe("failed");
    expect(blocked.error).toContain("片段正文");
    expect(flow.media.startComposition).not.toHaveBeenCalled();
  });
  it("checks structural edits before model review without overwriting the user's draft", async () => {
    const flow = setup({ documents: true });
    flow.approve();
    const first = await flow.run();
    const edited = patchMusicVideoArtifact(first, "timeline", {
      timeline: [{ ...timeline[0]!, endSeconds: 2 }, timeline[1]!],
      content: "用户自己修订的时间线",
    });
    flow.set({ ...flow.get(), config: { ...flow.get().config, checkpoint: edited } });
    flow.approve();
    const calls = vi.mocked(flow.fake.promptClient.run).mock.calls.length;
    const invalid = await flow.run(MUSIC_VIDEO_APPROVAL);
    expect(invalid.phase).toBe("failed");
    expect(invalid.error).toContain("空隙");
    expect(invalid.musicVideo?.stages.timeline?.artifact?.content).toBe("用户自己修订的时间线");
    expect(flow.fake.promptClient.run).toHaveBeenCalledTimes(calls);
  });

  it("recovers an already submitted video task without another audio preparation or paid submission", async () => {
    const flow = setup({ sync: true, audioProfile: true });
    await flow.planAll();
    flow.approve();
    await flow.run();
    flow.approve();
    const current = flow.get();
    flow.set({
      ...current,
      config: {
        ...current.config,
        checkpoint: {
          ...current.config.checkpoint,
          shotRuns: {
            ...current.config.checkpoint.shotRuns,
            "shot-1": {
              shotId: "shot-1",
              videoTaskId: "already-submitted",
              qcStatus: "pending",
              retryCount: 0,
            },
          },
        },
      },
    });
    const recovered = await flow.run();
    expect(recovered.executionPlan?.review?.kind).toBe("first_shot");
    expect(recovered.shotRuns["shot-1"]?.videoTaskId).toBe("already-submitted");
    expect(flow.fake.generation.get).toHaveBeenCalledWith("already-submitted");
    expect(flow.media.prepareAudioWindow).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(flow.fake.generation.start)
        .mock.calls.filter(([input]) => input.operation === "video_generation"),
    ).toHaveLength(0);
  });

  it("does not submit a paid video when paused while a native audio window is finishing", async () => {
    const flow = setup({ sync: true, audioProfile: true });
    await flow.planAll();
    flow.approve();
    await flow.run();
    flow.approve();
    const controller = new AbortController();
    vi.mocked(flow.media.prepareAudioWindow).mockImplementationOnce(
      (_path, sourceSignature, window) => {
        controller.abort();
        return Promise.resolve({
          path: "C:\\audio\\finished.wav",
          sourceSignature,
          window,
          durationSeconds: window.endSeconds - window.startSeconds,
          mimeType: "audio/wav",
        });
      },
    );
    const paused = await flow.runner.run({
      node: flow.get(),
      providerCatalog: flow.providerCatalog,
      resume: true,
      signal: controller.signal,
      onCheckpoint: vi.fn(),
      onProgress: vi.fn(),
    });
    expect(paused.phase).toBe("paused");
    expect(
      vi
        .mocked(flow.fake.generation.start)
        .mock.calls.filter(([input]) => input.operation === "video_generation"),
    ).toHaveLength(0);
  });
  it("forces single-shot MV through original-song composition", async () => {
    const single = { ...shots[0]!, startSeconds: 0, endSeconds: 4 };
    const flow = setup({ segments: [single], songDuration: 4 });
    flow.set({
      ...flow.get(),
      config: {
        ...flow.get().config,
        musicVideo: { ...flow.get().config.musicVideo!, lrc: "[00:00.00]完整一句歌词" },
      },
    });
    expect((await flow.planAll()).executionPlan?.scope).toBe("delivery");
    for (const kind of ["assets", "first_shot", "composition", "final"]) {
      flow.approve();
      expect((await flow.run()).executionPlan?.review?.kind).toBe(kind);
    }
    expect(flow.media.startComposition).toHaveBeenCalledTimes(1);
    expect(flow.media.startComposition).toHaveBeenCalledWith(
      expect.objectContaining({
        windows: [expect.objectContaining({ id: single.id, startSeconds: 0, endSeconds: 4 })],
      }),
    );
    expect(flow.media.prepareAudioWindow).not.toHaveBeenCalled();
  });
});
