import {
  workflowReferenceFixtures,
  workflowReferenceInputs,
  workflowConnectedReferenceFixtures,
} from "../../test/workflowMaterialFixtures";
import { catalog, node, fakeDependencies, planJson } from "../../test/videoWorkflowFixtures";
import { describe, expect, it, vi } from "../../test/workflowTest";
import {
  AI_FILM_STAGES,
  createAiFilmWorkflowOptions,
  type AiFilmStage,
} from "./aiFilmWorkflowModel";
import {
  createAiFilmWorkflowRunner,
  parseAiFilmRoute,
  parseAiFilmStage,
} from "./aiFilmWorkflowRunner";
import type { KnowledgeVideoWorkflowNodeData } from "./workspaceModel";
import type { OptimizeVideoPromptCommand } from "../../lib/backend";

const assets = [
  {
    id: "father",
    kind: "character",
    name: "修表匠",
    prompt: "灰发修表匠，蓝布工服，暖色写实电影肖像",
  },
  { id: "shop", kind: "scene", name: "钟表店", prompt: "温暖安静的木质钟表店，午后柔和光线" },
];
const routeData = (stages: readonly AiFilmStage[] = AI_FILM_STAGES, mode = "full") => ({
  schemaVersion: "ai-film-route.v1",
  status: "ready",
  mode,
  stages,
  title: "旧时光",
  aspectRatio: "9:16",
  reason: "完整制作父女和解短片",
  decision: null,
});
const stageData = (stage: AiFilmStage) => ({
  schemaVersion: "ai-film-stage.v1",
  stage,
  status: "ready",
  content: `# ${stage} 完整成果`,
  inputSummary: "本次父女和解故事资料",
  decision: null,
  assets: stage === "assets" ? assets : [],
  shots:
    stage === "prompts"
      ? [1, 2].map((id) => ({
          id: `shot-${id}`,
          sceneId: "scene-01",
          title: `钟表店镜头${id}`,
          durationSeconds: 5,
          visual: "修表匠在钟表店合上怀表",
          dialogue: "回来就好。",
          videoPrompt:
            "【素材描述】修表匠与钟表店【一句话概述】父亲与女儿和解【具体情节描述】0-3秒：合上怀表；3-5秒：看向女儿。【全局补充】暖色写实电影，稳定收尾。",
          referenceAssetIds: ["father", "shop"],
          acceptance: ["修表匠身份一致", "怀表状态连续"],
        }))
      : [],
});

function filmNode(): KnowledgeVideoWorkflowNodeData {
  const source = node();
  return {
    ...source,
    config: {
      ...source.config,
      brief: "拍一部修表匠与女儿和解的短片",
      film: createAiFilmWorkflowOptions(),
    },
  };
}

function packPrompt(output: unknown) {
  const optimizedPrompt = JSON.stringify(output);
  return { optimizedPrompt, rawModelOutput: optimizedPrompt };
}

function stubAiFilmPrompt(
  fake: ReturnType<typeof fakeDependencies>,
  stages: readonly AiFilmStage[],
  mode: string,
) {
  vi.when(fake.promptClient.run, {
    onUnmatched: (command) =>
      Promise.resolve(packPrompt(stageData(command.mode.replace("ai_film_", "") as AiFilmStage))),
  })
    .calledWith(expect.objectContaining({ mode: "ai_film_router" }) as OptimizeVideoPromptCommand)
    .thenResolve(packPrompt(routeData(stages, mode)))
    .calledWith(expect.objectContaining({ mode: "ai_film_qc" }) as OptimizeVideoPromptCommand)
    .thenResolve(packPrompt({ result: "PASS", report: "人物与场景连续" }));
}

function setup(
  stages: readonly AiFilmStage[] = AI_FILM_STAGES,
  mode = "full",
  fake: ReturnType<typeof fakeDependencies> = fakeDependencies(planJson()),
) {
  stubAiFilmPrompt(fake, stages, mode);
  const runner = createAiFilmWorkflowRunner({
    promptClient: fake.promptClient,
    generationClient: fake.generation,
    frameClient: fake.frames,
    composerClient: fake.composer,
    sleep: () => Promise.resolve(),
    now: () => 42,
  });
  const request = {
    node: filmNode(),
    providerCatalog: catalog,
    signal: new AbortController().signal,
    onCheckpoint: vi.fn(),
    onProgress: vi.fn(),
  };
  return { fake, runner, request };
}

describe("AI film composite workflow", () => {
  it("reads every general reference in planning and independent reviews and rejects changed resume inputs", async ({
    workflowFakes,
  }) => {
    const { runner, request, fake } = setup(AI_FILM_STAGES, "full", workflowFakes);
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

  it("runs eight isolated stages, generates project assets, references them in videos, and composes", async () => {
    const { fake, runner, request } = setup();
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    expect(result.film?.artifacts).toHaveLength(8);
    expect(result.film?.assets.every((asset) => asset.path)).toBe(true);
    expect(fake.composer.startComposition).toHaveBeenCalledTimes(1);
    const textCalls = vi.mocked(fake.promptClient.run).mock.calls.map(([command]) => command);
    expect(textCalls.slice(0, 9).map((command) => command.mode)).toEqual([
      "ai_film_router",
      ...AI_FILM_STAGES.map((stage) => `ai_film_${stage}`),
    ]);
    const submissions = vi.mocked(fake.generation.start).mock.calls.map(([command]) => command);
    expect(submissions).toHaveLength(4);
    expect(
      submissions.every((command) => command.providerConnectionId === "project-provider"),
    ).toBe(true);
    for (const command of submissions.filter(
      (command) => command.operation === "video_generation",
    )) {
      expect(command.explicitMedia).toHaveLength(2);
      expect(command.explicitMedia?.[0]?.target.kind).toBe("local_file");
      const prompt = command.prompt[0];
      if (prompt?.kind !== "text") throw new Error("Missing video prompt");
      expect(prompt.text).toContain("【逐字对白】回来就好。");
    }
  });

  it("delivers a requested stage with only a text model and never regenerates unrelated stages", async () => {
    const { fake, runner, request } = setup(["acting"], "stage");
    const source = request.node;
    const result = await runner.run({
      ...request,
      node: {
        ...source,
        config: {
          ...source.config,
          film: {
            entryStage: "acting",
            sourceText: "以此为准：父亲合上怀表，女儿回家。",
            deliverable: "documents",
          },
          models: {
            ...source.config.models,
            image: { providerId: "", modelDefinitionId: "" },
            video: { providerId: "", modelDefinitionId: "" },
          },
        },
      },
    });
    expect(result.phase).toBe("done");
    expect(result.documentsOnly).toBe(true);
    expect(result.finalPath).toBeNull();
    expect(result.film?.artifacts.map((artifact) => artifact.stage)).toEqual(["acting"]);
    expect(fake.generation.start).not.toHaveBeenCalled();
    expect(fake.promptClient.run).toHaveBeenCalledTimes(2);
  });

  it("resumes a stage decision with the customer answer without repeating completed stages", async () => {
    const { fake, runner, request } = setup();
    const normal = vi.mocked(fake.promptClient.run).getMockImplementation()!;
    let pending = true;
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "ai_film_screenplay" && pending) {
        pending = false;
        const output = JSON.stringify({
          ...stageData("screenplay"),
          status: "needs_confirmation",
          decision: { question: "父亲是否知道女儿将回来？", recommendation: "父亲事先不知情" },
        });
        return Promise.resolve({ optimizedPrompt: output, rawModelOutput: output });
      }
      return normal(command);
    });
    const first = await runner.run(request);
    expect(first.phase).toBe("awaiting_approval");
    expect(first.film?.artifacts).toHaveLength(4);
    expect(fake.generation.start).not.toHaveBeenCalled();
    const second = await runner.run({
      ...request,
      resume: true,
      decisionResolution: "父亲早已知情，克制地等待",
      node: { ...request.node, config: { ...request.node.config, checkpoint: first } },
    });
    expect(second.phase).toBe("done");
    const calls = vi.mocked(fake.promptClient.run).mock.calls.map(([command]) => command);
    expect(calls.filter((command) => command.mode === "ai_film_synopsis")).toHaveLength(1);
    expect(
      calls.filter((command) => command.mode === "ai_film_screenplay").at(-1)?.userPrompt,
    ).toContain("父亲早已知情，克制地等待");
  });

  it("versions a screenplay revision and marks downstream work stale without regenerating media", async () => {
    const { runner, request } = setup();
    const first = await runner.run(request);
    const revision = setup(["screenplay"], "revision");
    const second = await revision.runner.run({
      ...revision.request,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          brief: "回到剧本阶段，修改父亲动机，先不重做下游",
          checkpoint: first,
        },
      },
    });
    expect(second.phase).toBe("done");
    expect(
      second.film?.history.some(
        (artifact) => artifact.stage === "screenplay" && artifact.version === 1,
      ),
    ).toBe(true);
    expect(
      second.film?.artifacts.find((artifact) => artifact.stage === "screenplay")?.version,
    ).toBe(2);
    expect(second.film?.artifacts.find((artifact) => artifact.stage === "assets")?.stale).toBe(
      true,
    );
    expect(revision.fake.generation.start).not.toHaveBeenCalled();
  });

  it("rejects incomplete full routes and invented asset references", () => {
    expect(() => parseAiFilmRoute(JSON.stringify(routeData(["synopsis"], "full")))).toThrow(
      "必要制作阶段",
    );
    expect(() => parseAiFilmStage(JSON.stringify(stageData("prompts")), "prompts", [])).toThrow(
      "不存在的资产",
    );
  });

  it("honors document delivery when resuming an already planned media run", async () => {
    const { runner, request } = setup();
    const first = await runner.run(request);
    const resumed = setup();
    const result = await resumed.runner.run({
      ...resumed.request,
      resume: true,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          film: { ...createAiFilmWorkflowOptions(), deliverable: "documents" },
          checkpoint: {
            ...first,
            phase: "paused",
            documentsOnly: false,
            shotRuns: {},
            finalPath: null,
          },
        },
      },
    });
    expect(result.phase).toBe("done");
    expect(result.documentsOnly).toBe(true);
    expect(resumed.fake.generation.start).not.toHaveBeenCalled();
    expect(resumed.fake.composer.startComposition).not.toHaveBeenCalled();
    expect(resumed.fake.promptClient.run).not.toHaveBeenCalled();
  });

  it("repairs unsupported shot durations before submitting media tasks", async () => {
    const { fake, runner, request } = setup();
    const normal = vi.mocked(fake.promptClient.run).getMockImplementation()!;
    let firstPrompt = true;
    vi.mocked(fake.promptClient.run).mockImplementation((command) => {
      if (command.mode === "ai_film_prompts" && firstPrompt) {
        firstPrompt = false;
        const data = stageData("prompts");
        const raw = JSON.stringify({
          ...data,
          shots: data.shots.map((shot) => ({ ...shot, durationSeconds: 30 })),
        });
        return Promise.resolve({ optimizedPrompt: raw, rawModelOutput: raw });
      }
      return normal(command);
    });
    const result = await runner.run(request);
    expect(result.phase).toBe("done");
    const promptCalls = vi
      .mocked(fake.promptClient.run)
      .mock.calls.map(([command]) => command)
      .filter((command) => command.mode === "ai_film_prompts");
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[1]?.userPrompt).toContain("请按供应商时长拆镜");
    expect(result.shots.every((shot) => shot.durationSeconds === 5)).toBe(true);
  });

  it("does not generate stale assets when continuing from new prompts", async () => {
    const initial = setup();
    const first = await initial.runner.run({
      ...initial.request,
      node: {
        ...initial.request.node,
        config: {
          ...initial.request.node.config,
          film: { ...createAiFilmWorkflowOptions(), deliverable: "documents" },
        },
      },
    });
    const next = setup(["prompts"], "handoff");
    const normal = vi.mocked(next.fake.promptClient.run).getMockImplementation()!;
    vi.mocked(next.fake.promptClient.run).mockImplementation((command) => {
      if (command.mode !== "ai_film_prompts") return normal(command);
      const data = stageData("prompts");
      const raw = JSON.stringify({
        ...data,
        shots: data.shots.map((shot) => ({ ...shot, referenceAssetIds: [] })),
      });
      return Promise.resolve({ optimizedPrompt: raw, rawModelOutput: raw });
    });
    const result = await next.runner.run({
      ...next.request,
      node: {
        ...next.request.node,
        config: {
          ...next.request.node.config,
          checkpoint: {
            ...first,
            film: {
              ...first.film!,
              artifacts: first.film!.artifacts.map((artifact) =>
                artifact.stage === "assets" ? { ...artifact, stale: true } : artifact,
              ),
            },
          },
        },
      },
    });
    expect(result.phase).toBe("done");
    const images = vi
      .mocked(next.fake.generation.start)
      .mock.calls.map(([command]) => command)
      .filter((command) => command.operation === "text_to_image");
    expect(images).toHaveLength(1);
    expect(images[0]?.prompt).not.toEqual([{ kind: "text", text: assets[0]!.prompt }]);
    expect(result.manifest).toContain('"assets":[]');
  });

  it("blocks resumed shots that no longer fit the selected video model", async () => {
    const initial = setup();
    const first = await initial.runner.run(initial.request);
    const next = setup();
    const result = await next.runner.run({
      ...next.request,
      resume: true,
      node: {
        ...next.request.node,
        config: {
          ...next.request.node.config,
          checkpoint: {
            ...first,
            phase: "paused",
            shots: first.shots.map((shot) => ({ ...shot, durationSeconds: 30 })),
          },
        },
      },
    });
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("与当前视频模型不兼容");
    expect(next.fake.generation.start).not.toHaveBeenCalled();
  });
});
