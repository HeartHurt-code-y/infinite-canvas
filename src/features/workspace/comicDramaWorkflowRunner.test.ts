import { describe, expect, it, vi } from "vitest";
import {
  workflowReferenceFixtures,
  workflowReferenceInputs,
  workflowConnectedReferenceFixtures,
} from "../../test/workflowMaterialFixtures";
import { stableJsonSignature } from "../../lib/workflowSignatures";
import type { OptimizeVideoPromptCommand } from "../../lib/backend";
import { catalog, fakeDependencies, node, planJson } from "../../test/videoWorkflowFixtures";
import {
  COMIC_DRAMA_STAGES,
  comicDramaStageDependencies,
  createComicDramaOptions,
  type ComicDramaStage,
} from "./comicDramaWorkflowModel";
import {
  approveWorkflowExecutionPlan,
  topologicallySortWorkflowSteps,
} from "./workflowExecutionPlan";
import {
  createComicDramaWorkflowRunner,
  COMIC_DRAMA_APPROVAL,
  comicDramaDialogueCapacity,
  parseComicDramaReview,
  parseComicDramaStage,
} from "./comicDramaWorkflowRunner";
import type { KnowledgeVideoWorkflowNodeData } from "./workspaceModel";
import type { KnowledgeVideoWorkflowRunRequest } from "./knowledgeVideoWorkflowRunner";

const sharedAssets = [
  { id: "father", kind: "character", name: "修表匠", prompt: "灰发修表匠，蓝布工服，暖色电影光影" },
  { id: "shop", kind: "scene", name: "钟表店", prompt: "木质钟表店，柜台在画面左侧，暖色光线" },
];
const stageData = (stage: ComicDramaStage, episodeId = "ep01") => ({
  schemaVersion: "comic-drama-stage.v1",
  stage,
  status: "ready",
  content: `# ${episodeId} ${stage} 完整成果`,
  inputSummary: `${episodeId} 原始剧本及已通过双审的上游成果`,
  decision: null,
  assets: stage === "art" ? sharedAssets : [],
  shots:
    stage === "storyboard"
      ? [
          {
            id: "P1-1",
            sceneId: "clock-shop",
            title: "父女重逢",
            durationSeconds: 5,
            visual: "修表匠在柜台后合上怀表",
            dialogue: "回来就好。",
            videoPrompt:
              "shop 固定钟表店空间，father 固定修表匠身份；镜头缓缓推近，他合上怀表，抬头看向女儿。",
            referenceAssetIds: ["shop", "father"],
            acceptance: ["修表匠身份一致", "怀表状态连续"],
          },
        ]
      : [],
});
const pass = { result: "PASS", report: "检查通过" };
const revise = (instruction: string) => ({
  result: "REVISE",
  report: instruction,
  repairInstructions: instruction,
});
const response = (data: object) => {
  const raw = JSON.stringify(data);
  return Promise.resolve({ optimizedPrompt: raw, rawModelOutput: raw });
};
const normalResponse = (command: OptimizeVideoPromptCommand) => {
  if (command.mode.endsWith("_review") || command.mode === "ai_film_qc") return response(pass);
  const stage = command.mode.replace("comic_drama_", "") as ComicDramaStage;
  const episodeId = /当前仅处理剧集：([^（]+)/.exec(command.userPrompt)?.[1] ?? "ep01";
  return response(stageData(stage, episodeId));
};

function setup(deliverable: "video" | "documents" = "documents") {
  const fake = fakeDependencies(planJson());
  vi.mocked(fake.promptClient.run).mockImplementation(normalResponse);
  let imageIndex = 0;
  let videoIndex = 0;
  vi.mocked(fake.generation.start).mockImplementation((command) =>
    Promise.resolve(
      command.operation === "text_to_image" ? `image-${++imageIndex}` : `video-${++videoIndex}`,
    ),
  );
  const source = node();
  const dramaNode: KnowledgeVideoWorkflowNodeData = {
    ...source,
    config: {
      ...source.config,
      brief: "按原文制作父女和解漫剧",
      comicDrama: {
        ...createComicDramaOptions(),
        episodes: [
          { id: "ep01", title: "第一集", script: "父亲合上怀表，女儿回家。他说：回来就好。" },
        ],
        deliverable,
      },
    },
  };
  const rawRunner = createComicDramaWorkflowRunner({
    promptClient: fake.promptClient,
    generationClient: fake.generation,
    frameClient: fake.frames,
    composerClient: fake.composer,
    sleep: () => Promise.resolve(),
    now: () => 42,
  });
  const runner = {
    async run(initial: KnowledgeVideoWorkflowRunRequest) {
      let next = initial;
      for (let step = 0; step < 80; step += 1) {
        const checkpoint = await rawRunner.run(next);
        if (checkpoint.phase !== "awaiting_approval") return checkpoint;
        const resumedNode = { ...next.node, config: { ...next.node.config, checkpoint } };
        if (
          checkpoint.comicDrama?.pending?.step === "approval" &&
          checkpoint.decision?.recommendation === COMIC_DRAMA_APPROVAL
        ) {
          next = {
            ...next,
            node: resumedNode,
            resume: true,
            decisionResolution: COMIC_DRAMA_APPROVAL,
          };
          continue;
        }
        if (checkpoint.executionPlan && !checkpoint.executionPlan.approval) {
          next = {
            ...next,
            node: {
              ...resumedNode,
              config: {
                ...resumedNode.config,
                checkpoint: {
                  ...checkpoint,
                  executionPlan: approveWorkflowExecutionPlan(
                    checkpoint.executionPlan,
                    resumedNode,
                    42,
                  ),
                },
              },
            },
            resume: true,
          };
          continue;
        }
        return checkpoint;
      }
      throw new Error("Workflow approval loop did not finish");
    },
  };
  const request = {
    node: dramaNode,
    providerCatalog: catalog,
    signal: new AbortController().signal,
    onCheckpoint: vi.fn(),
    onProgress: vi.fn(),
  };
  const calls = () => vi.mocked(fake.promptClient.run).mock.calls.map(([command]) => command);
  return { fake, runner, rawRunner, request, calls };
}

describe("comic drama composite workflow", () => {
  it("waits for a real user approval after both reviews and preserves a rejected draft as a new version", async () => {
    const { rawRunner, request, fake, calls } = setup();
    const first = await rawRunner.run(request);
    expect(first.phase).toBe("awaiting_approval");
    expect(first.comicDrama?.pending).toEqual({
      episodeId: "ep01",
      stage: "screenplay",
      step: "approval",
    });
    expect(calls().map((call) => call.mode)).toEqual([
      "comic_drama_screenplay",
      "comic_drama_screenplay_review",
      "comic_drama_content_review",
    ]);
    expect(fake.generation.start).not.toHaveBeenCalled();
    const merelyResumed = await rawRunner.run({
      ...request,
      resume: true,
      node: { ...request.node, config: { ...request.node.config, checkpoint: first } },
    });
    expect(merelyResumed.comicDrama?.pending?.stage).toBe("screenplay");
    expect(
      merelyResumed.comicDrama?.episodes[0]?.stages.screenplay?.approvedVersion,
    ).toBeUndefined();
    expect(calls()).toHaveLength(3);
    const edited = await rawRunner.run({
      ...request,
      resume: true,
      decisionResolution: "保留父亲的迟疑，再明确结尾",
      node: { ...request.node, config: { ...request.node.config, checkpoint: first } },
    });
    expect(edited.phase).toBe("awaiting_approval");
    expect(edited.comicDrama?.episodes[0]?.stages.screenplay?.artifact?.version).toBe(2);
    expect(edited.comicDrama?.episodes[0]?.stages.screenplay?.history).toHaveLength(1);
    expect(edited.comicDrama?.episodes[0]?.stages.screenplay?.approvedVersion).toBeUndefined();
    expect(calls()[3]?.userPrompt).toContain("保留父亲的迟疑");
    const approved = await rawRunner.run({
      ...request,
      resume: true,
      decisionResolution: COMIC_DRAMA_APPROVAL,
      node: { ...request.node, config: { ...request.node.config, checkpoint: edited } },
    });
    expect(approved.comicDrama?.episodes[0]?.stages.screenplay?.approvedVersion).toBe(2);
    expect(approved.comicDrama?.pending?.stage).toBe("style");
    expect(approved.comicDrama?.episodes[0]?.stages.screenplay?.approvals).toHaveLength(1);
  });

  it("uses dependency order even when the episode stage graph is shuffled", () => {
    const episodes = [
      { id: "one", title: "一", script: "a" },
      { id: "two", title: "二", script: "b" },
    ];
    const graph = comicDramaStageDependencies(episodes).reverse();
    expect(topologicallySortWorkflowSteps(graph).map((step) => step.id)).toEqual(
      episodes.flatMap((episode) => COMIC_DRAMA_STAGES.map((stage) => `${episode.id}:${stage}`)),
    );
  });

  it("qualifies actual shot dependencies and continuity identities by episode", () => {
    const art = parseComicDramaStage(JSON.stringify(stageData("art")), "art", "ep02", []).assets;
    const data = stageData("storyboard");
    const shots = [{ ...data.shots[0], dependsOn: ["P0"], continuationFromShotId: "ep01:P9" }];
    const parsed = parseComicDramaStage(
      JSON.stringify({ ...data, shots }),
      "storyboard",
      "ep02",
      art,
    );
    expect(parsed.shots[0]?.dependsOn).toEqual(["ep02:P0"]);
    expect(parsed.shots[0]?.continuationFromShotId).toBe("ep01:P9");
    expect(() =>
      parseComicDramaStage(
        JSON.stringify({ ...data, shots: [{ ...shots[0], dependsOn: ["P1-1"] }] }),
        "storyboard",
        "ep02",
        art,
      ),
    ).toThrow("依赖自身");
  });

  it("enforces dialogue capacity without importing a provider-specific frame grid and closes spoken lines", () => {
    expect(comicDramaDialogueCapacity(5, "回来就好")).toBe(17);
    const art = parseComicDramaStage(JSON.stringify(stageData("art")), "art", "ep01", []).assets;
    const data = stageData("storyboard");
    data.shots[0]!.videoPrompt = "父亲 says: <d>[中文]回来就好。</d>";
    const shot = parseComicDramaStage(JSON.stringify(data), "storyboard", "ep01", art).shots[0]!;
    expect(shot.videoPrompt).toContain("</d> 说完嘴唇合上。");
    expect(shot.videoPrompt.match(/回来就好/g)).toHaveLength(1);
    data.shots[0]!.dialogue = "这段台词超过了五秒镜头所能容纳的实际容量需要拆镜头";
    expect(() => parseComicDramaStage(JSON.stringify(data), "storyboard", "ep01", art)).toThrow(
      "对白超过当前时长容量",
    );
  });

  it("reads every general reference in planning and independent reviews and rejects changed resume inputs", async () => {
    const { runner, request, fake } = setup();
    const withMaterials = {
      ...request,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          materials: workflowReferenceFixtures,
          connectedMaterials: workflowConnectedReferenceFixtures,
        },
      },
    };
    const checkpoint = await runner.run(withMaterials);
    expect(checkpoint.phase).toBe("done");
    const calls = vi.mocked(fake.promptClient.run).mock.calls.map(([input]) => input);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const input of calls) {
      expect(input.multimodalInputs).toEqual(workflowReferenceInputs);
      expect(input.referenceInputs).toEqual(workflowConnectedReferenceFixtures);
    }
    vi.mocked(fake.promptClient.run).mockClear();
    const resumed = await runner.run({
      ...withMaterials,
      resume: true,
      node: {
        ...withMaterials.node,
        config: {
          ...withMaterials.node.config,
          materials: [],
          checkpoint: { ...checkpoint, phase: "paused" },
        },
      },
    });
    expect(resumed.error).toContain("参考素材已修改");
    expect(fake.promptClient.run).not.toHaveBeenCalled();
  });

  it("runs generation and independent business/content reviews for all five stages using only the project text model", async () => {
    const { fake, runner, request, calls } = setup();
    const result = await runner.run({
      ...request,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          models: {
            ...request.node.config.models,
            image: { providerId: "", modelDefinitionId: "" },
            video: { providerId: "", modelDefinitionId: "" },
          },
        },
      },
    });
    expect(result.phase).toBe("done");
    expect(result.documentsOnly).toBe(true);
    expect(result.finalPath).toBeNull();
    expect(calls().map((command) => command.mode)).toEqual(
      COMIC_DRAMA_STAGES.flatMap((stage) => [
        `comic_drama_${stage}`,
        `comic_drama_${stage}_review`,
        "comic_drama_content_review",
      ]),
    );
    expect(
      calls().every(
        (command) =>
          command.providerConnectionId === "project-provider" &&
          command.modelDefinitionId === "project-text",
      ),
    ).toBe(true);
    expect(calls()[12]?.userPrompt).toContain("ep01 director 完整成果");
    expect(calls()[9]?.userPrompt).toContain("ep01 art 完整成果");
    expect(
      Object.values(result.comicDrama!.episodes[0]!.stages).every(
        (run) =>
          run.passed &&
          run.businessReview?.result === "PASS" &&
          run.contentReview?.result === "PASS",
      ),
    ).toBe(true);
    expect(fake.generation.start).not.toHaveBeenCalled();
    expect(fake.composer.startComposition).not.toHaveBeenCalled();
  });

  it("merges both failed reviews into one revision and repeats both checks before advancing", async () => {
    const { fake, runner, request, calls } = setup();
    let business = 0;
    let content = 0;
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "comic_drama_director_review" && business++ === 0)
        return response(revise("补全剧情点 P2"));
      if (
        command.mode === "comic_drama_content_review" &&
        command.userPrompt.includes("阶段：director") &&
        content++ === 0
      )
        return response(revise("补充父亲克制的动作"));
      return normalResponse(command);
    });
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(calls()).toHaveLength(18);
    const repairs = calls().filter((command) => command.mode === "comic_drama_director");
    expect(repairs).toHaveLength(2);
    expect(repairs[1]?.userPrompt).toContain("补全剧情点 P2");
    expect(repairs[1]?.userPrompt).toContain("补充父亲克制的动作");
    expect(
      calls()
        .slice(12, 16)
        .map((command) => command.mode),
    ).toEqual([
      "comic_drama_director",
      "comic_drama_director_review",
      "comic_drama_content_review",
      "comic_drama_storyboard",
    ]);
    expect(result.comicDrama?.episodes[0]?.stages.director?.artifact?.version).toBe(2);
    expect(result.comicDrama?.episodes[0]?.stages.director?.history).toHaveLength(1);
  });

  it("resumes a legacy signature after a serde-style key-order round trip by requesting only the missing review", async () => {
    const { fake, runner, request, calls } = setup();
    let interrupted = false;
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "comic_drama_content_review" && !interrupted) {
        interrupted = true;
        return Promise.reject(new Error("review connection interrupted"));
      }
      return normalResponse(command);
    });
    const first = await runner.run(request);
    expect(first.phase).toBe("failed");
    expect(first.comicDrama?.episodes[0]?.stages.screenplay?.businessReview?.result).toBe("PASS");
    expect(first.comicDrama?.episodes[0]?.stages.screenplay?.contentReview).toBeNull();
    const options = request.node.config.comicDrama!;
    const restored = {
      ...request.node,
      config: {
        ...request.node.config,
        checkpoint: {
          ...first,
          comicDrama: {
            ...first.comicDrama!,
            inputSignature: JSON.stringify({
              brief: request.node.config.brief,
              episodes: options.episodes,
              visualStyle: options.visualStyle,
              aspectRatio: options.aspectRatio,
            }),
          },
        },
      },
    };
    const next = await runner.run({
      ...request,
      resume: true,
      node: JSON.parse(stableJsonSignature(restored)) as KnowledgeVideoWorkflowNodeData,
    });
    expect(next.phase).toBe("done");
    expect(calls()).toHaveLength(16);
    expect(calls().filter((command) => command.mode === "comic_drama_screenplay")).toHaveLength(1);
    expect(
      calls().filter((command) => command.mode === "comic_drama_director_review"),
    ).toHaveLength(1);
    expect(fake.generation.start).not.toHaveBeenCalled();
  });

  it("applies a confirmed creative decision through a revision and two fresh reviews", async () => {
    const { fake, runner, request, calls } = setup();
    let pending = true;
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "comic_drama_director_review" && pending) {
        pending = false;
        return response({
          result: "NEEDS_DECISION",
          report: "动机存在两种解释",
          question: "父亲是否预知女儿回来？",
          recommendation: "父亲不知情",
        });
      }
      return normalResponse(command);
    });
    const first = await runner.run(request);
    expect(first.phase).toBe("awaiting_approval");
    expect(calls()).toHaveLength(12);
    expect(first.comicDrama?.episodes[0]?.stages.director?.passed).toBe(false);
    const next = await runner.run({
      ...request,
      resume: true,
      decisionResolution: "父亲早已知情但没有说破",
      node: { ...request.node, config: { ...request.node.config, checkpoint: first } },
    });
    expect(next.phase).toBe("done");
    expect(calls()[12]?.userPrompt).toContain("父亲早已知情但没有说破");
    expect(
      calls()
        .slice(12, 16)
        .map((command) => command.mode),
    ).toEqual([
      "comic_drama_director",
      "comic_drama_director_review",
      "comic_drama_content_review",
      "comic_drama_storyboard",
    ]);
  });

  it("keeps reworking automatically on revise without a retry limit, accepting only a passed review", async () => {
    const { fake, runner, request, calls } = setup();
    let reviewCalls = 0;
    vi.mocked(fake.promptClient.run).mockImplementation((command) =>
      command.mode === "comic_drama_director_review"
        ? (reviewCalls += 1) <= 2
          ? response(revise("仍缺少关键剧情"))
          : normalResponse(command)
        : normalResponse(command),
    );
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(reviewCalls).toBe(3);
    expect(calls().filter((command) => command.mode === "comic_drama_director")).toHaveLength(3);
  });

  it("reuses fixed assets across episodes without mixing their scripts or colliding shot IDs", async () => {
    const { fake, runner, request, calls } = setup("video");
    request.node = {
      ...request.node,
      config: {
        ...request.node.config,
        comicDrama: {
          ...request.node.config.comicDrama!,
          episodes: [
            { id: "ep01", title: "第一集", script: "第一集的秘密：女儿回家。" },
            { id: "ep02", title: "第二集", script: "第二集的秘密：父女一起修表。" },
          ],
        },
      },
    };
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(result.comicDrama?.sharedAssets).toHaveLength(2);
    expect(result.shots.map((shot) => shot.id)).toEqual(["ep01:P1-1", "ep02:P1-1"]);
    expect(result.shots.map((shot) => shot.sequence)).toEqual([1, 2]);
    const secondDirector = calls().filter((command) => command.mode === "comic_drama_director")[1];
    expect(secondDirector?.userPrompt).toContain("第二集的秘密");
    expect(secondDirector?.userPrompt).not.toContain("第一集的秘密");
    expect(secondDirector?.userPrompt).not.toContain("ep01 director 完整成果");
    const submissions = vi.mocked(fake.generation.start).mock.calls.map(([command]) => command);
    expect(submissions.filter((command) => command.operation === "text_to_image")).toHaveLength(2);
    const videos = submissions.filter((command) => command.operation === "video_generation");
    expect(videos).toHaveLength(2);
    expect(
      submissions.every((command) => command.providerConnectionId === "project-provider"),
    ).toBe(true);
    for (const video of videos) {
      expect(video.modelDefinitionId).toBe("project-video");
      expect(video.explicitMedia?.map((media) => media.target)).toEqual([
        { kind: "local_file", path: "C:\\output\\image-2.png", mediaType: "image" },
        { kind: "local_file", path: "C:\\output\\image-1.png", mediaType: "image" },
      ]);
      expect(video.explicitMedia?.map((media) => media.typePosition)).toEqual([1, 2]);
      const prompt = video.prompt[0];
      if (prompt?.kind !== "text") throw new Error("Missing video prompt");
      expect(prompt.text).toContain("图片1 对应资产 shop（钟表店）");
      expect(prompt.text).toContain("图片2 对应资产 father（修表匠）");
      expect(prompt.text).toContain("【逐字对白】回来就好。");
    }
    expect(fake.composer.startComposition).toHaveBeenCalledTimes(1);
    expect(result.finalPath).toBeTruthy();
  });

  it("rejects input changes before using an already completed plan on resume", async () => {
    const { fake, runner, request, calls } = setup();
    const first = await runner.run(request);
    const callCount = calls().length;
    const result = await runner.run({
      ...request,
      resume: true,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          brief: "修改结局：女儿没有回来",
          checkpoint: { ...first, phase: "paused" },
        },
      },
    });
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("剧集资料已修改，请重新执行");
    expect(calls()).toHaveLength(callCount);
    expect(fake.generation.start).not.toHaveBeenCalled();
    expect(result.comicDrama?.episodes[0]?.stages.director?.artifact).toEqual(
      first.comicDrama?.episodes[0]?.stages.director?.artifact,
    );
  });

  it("does not trust a saved passed flag when one review still requires changes", async () => {
    const { runner, request, calls } = setup();
    const first = await runner.run(request);
    const episode = first.comicDrama!.episodes[0]!;
    const result = await runner.run({
      ...request,
      resume: true,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          checkpoint: {
            ...first,
            phase: "paused",
            comicDrama: {
              ...first.comicDrama!,
              episodes: [
                {
                  ...episode,
                  stages: {
                    ...episode.stages,
                    director: {
                      ...episode.stages.director!,
                      passed: true,
                      businessReview: {
                        result: "REVISE",
                        report: "未覆盖原文",
                        repairInstructions: "补齐原文",
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    expect(result.phase).toBe("done");
    const reviewCommands = calls().filter(
      (command) => command.mode === "comic_drama_director_review",
    );
    expect(reviewCommands.length).toBeGreaterThan(0);
  });

  it("rejects shared identity rewrites, missing local reference IDs, and conflicting PASS contracts", () => {
    const parsed = parseComicDramaStage(JSON.stringify(stageData("art")), "art", "ep02", []);
    const changed = {
      ...stageData("art"),
      assets: sharedAssets.map((asset) => ({ ...asset, prompt: `${asset.prompt}，新服装` })),
    };
    expect(() =>
      parseComicDramaStage(JSON.stringify(changed), "art", "ep02", parsed.assets),
    ).toThrow("固定描述被改写");
    expect(() =>
      parseComicDramaStage(JSON.stringify(stageData("storyboard")), "storyboard", "ep01", []),
    ).toThrow("未确认的资产");
    expect(() =>
      parseComicDramaReview(JSON.stringify({ ...pass, repairInstructions: "还需修订" })),
    ).toThrow("PASS 审查不能");
  });
});
