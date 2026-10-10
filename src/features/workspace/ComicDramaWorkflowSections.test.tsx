import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { node, catalog } from "../../test/videoWorkflowFixtures";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import { ComicDramaConfiguration, ComicDramaDeliverables } from "./ComicDramaWorkflowSections";
import {
  comicDramaDeliveryMarkdown,
  comicDramaDeliveryBundle,
  comicDramaInputReady,
  comicDramaRequirements,
  createComicDramaCheckpoint,
  createComicDramaOptions,
  type ComicDramaWorkflowOptions,
} from "./comicDramaWorkflowModel";
import type { KnowledgeVideoWorkflowConfig } from "./workspaceModel";

const speakingShot = {
  id: "ep01:P1",
  sequence: 1,
  section: "FILM" as const,
  track: "FILM" as const,
  title: "父亲开口",
  durationSeconds: 5,
  visual: "父亲抬头",
  narration: "回来就好。",
  dialogueLines: [{ speakerId: "father", text: "回来就好。", startSeconds: 0.8 }],
  videoPrompt: "父亲说回来就好。",
  acceptance: "口型与对白一致",
};

function speakingCheckpoint() {
  const source = node().config.checkpoint;
  return {
    ...source,
    phase: "awaiting_approval" as const,
    shots: [speakingShot],
    shotRuns: {
      [speakingShot.id]: {
        shotId: speakingShot.id,
        qcStatus: "passed" as const,
        retryCount: 0,
        videoTaskId: "video-1",
        clipPath: "C:\\output\\video.mp4",
      },
    },
    comicDrama: {
      ...createComicDramaCheckpoint(),
      pending: { episodeId: "ep01", stage: "storyboard" as const, step: "voice_binding" as const },
      sharedAssets: [{ id: "father", kind: "character" as const, name: "父亲", prompt: "修表匠" }],
      episodes: [
        {
          id: "ep01",
          title: "第一集",
          script: "剧本",
          stages: {
            storyboard: {
              artifact: {
                content: "分镜",
                inputSummary: "剧本",
                version: 1,
                createdAt: 1,
                assets: [],
                shots: [speakingShot],
              },
              businessReview: { result: "PASS" as const, report: "通过" },
              contentReview: { result: "PASS" as const, report: "通过" },
              approvedVersion: 1,
              passed: true,
              repairCount: 0,
              history: [],
            },
          },
        },
      ],
    },
  };
}

describe("comic drama node", () => {
  it("lets the user bind a provider model and control-panel voice at the voice gate", () => {
    const checkpoint = speakingCheckpoint();
    const providerCatalog = catalog.map((entry) => ({
      ...entry,
      models: [
        ...entry.models,
        {
          definitionId: "project-speech",
          remoteModelId: "seed-tts-2.0",
          displayName: "豆包语音",
          operations: ["speech_generation"] as (typeof entry.models)[number]["operations"],
          operationSchema: {},
        },
      ],
    }));
    function Harness() {
      const [options, setOptions] = useState(createComicDramaOptions());
      return (
        <ComicDramaConfiguration
          options={options}
          checkpoint={checkpoint}
          providerCatalog={providerCatalog}
          brief=""
          disabled
          onChange={setOptions}
          onBriefChange={vi.fn()}
        />
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("漫剧语音供应商"), {
      target: { value: "project-provider" },
    });
    expect(screen.getByLabelText("漫剧语音模型")).toHaveValue("project-speech");
    fireEvent.change(screen.getByLabelText("父亲控制台音色 ID"), {
      target: { value: "console-voice-father" },
    });
    expect(screen.getByLabelText("父亲控制台音色 ID")).toHaveValue("console-voice-father");
    expect(screen.getByText(/需账号已开通/)).toBeInTheDocument();
  });

  it("shows the actual dubbed clip for an explicit shot-by-shot lip decision", async () => {
    const checkpoint = speakingCheckpoint();
    const onReviewDubbedShot = vi
      .fn()
      .mockRejectedValueOnce(new Error("配音视频文件已改变"))
      .mockResolvedValueOnce(undefined);
    render(
      <ComicDramaDeliverables
        checkpoint={{
          ...checkpoint,
          comicDrama: {
            ...checkpoint.comicDrama,
            pending: null,
            speech: {
              voiceBindingsSignature: "voice-signature",
              lines: {
                "ep01:P1#0": {
                  shotId: "ep01:P1",
                  lineIndex: 0,
                  speakerId: "father",
                  text: "回来就好。",
                  startSeconds: 0.8,
                  voiceId: "console-voice-father",
                  providerId: "project-provider",
                  modelDefinitionId: "project-speech",
                  requestId: "run:speech:ep01:P1:0",
                  requestSignature: "a".repeat(64),
                  path: "C:\\output\\voice.wav",
                  durationSeconds: 1,
                },
              },
              dubbedClips: {
                "ep01:P1": {
                  sourcePath: "C:\\output\\video.mp4",
                  sourceVideoTaskId: "video-1",
                  speechSignature: "speech-signature",
                  requestId: "run:dub:ep01:P1:video-1",
                  requestSignature: "b".repeat(64),
                  videoSignature: "c".repeat(64),
                  path: "C:\\output\\dubbed.mp4",
                  durationSeconds: 5,
                },
              },
            },
          },
        }}
        onReviewDubbedShot={onReviewDubbedShot}
      />,
    );
    expect(screen.getByLabelText("父亲开口配音预览")).toHaveAttribute(
      "src",
      "C:\\output\\dubbed.mp4",
    );
    fireEvent.click(screen.getByRole("button", { name: "口型通过，采用本镜" }));
    expect(onReviewDubbedShot).toHaveBeenCalledWith("ep01:P1", "approved");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("配音视频文件已改变"));
    fireEvent.click(screen.getByRole("button", { name: "口型不通过" }));
    expect(onReviewDubbedShot).toHaveBeenCalledWith("ep01:P1", "rejected");
  });

  it("requires all episode scripts but only a text model for document delivery", () => {
    const source = node();
    function Harness() {
      const [config, setConfig] = useState<KnowledgeVideoWorkflowConfig>({
        ...source.config,
        brief: "",
        comicDrama: { ...createComicDramaOptions(), deliverable: "documents" },
        models: {
          ...source.config.models,
          image: { providerId: "", modelDefinitionId: "" },
          video: { providerId: "", modelDefinitionId: "" },
        },
      });
      return (
        <KnowledgeVideoWorkflowNode
          node={{ ...source, config }}
          providerCatalog={catalog}
          onChange={setConfig}
          onExecute={vi.fn()}
          onContinue={vi.fn()}
          onCancel={vi.fn()}
          onRemove={vi.fn()}
          onRevealResult={vi.fn()}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeDisabled();
    fireEvent.click(screen.getByText("分集剧本与制作设置"));
    fireEvent.change(screen.getByLabelText("第 1 集剧本"), {
      target: { value: "女儿推门进店，父亲抬头微笑。" },
    });
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "添加一集" }));
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "移除第 2 集" }));
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeEnabled();
  });

  it("lists every missing episode script as a required gap", () => {
    render(
      <ComicDramaConfiguration
        options={createComicDramaOptions()}
        brief=""
        disabled={false}
        onChange={vi.fn()}
        onBriefChange={vi.fn()}
      />,
    );
    // 默认一集空剧本：剧本标签带红色星号，交付格式参数保持选填。
    expect(
      screen.getByText("完整剧本").querySelector(".workflow-required-mark__asterisk"),
    ).not.toBeNull();
    expect(
      screen.getByText("集名").querySelector(".workflow-required-mark__asterisk"),
    ).not.toBeNull();
    const formatMark = screen.getByText("画幅");
    expect(formatMark.querySelector(".workflow-required-mark__optional")).not.toBeNull();
    expect(formatMark.querySelector(".workflow-required-mark__asterisk")).toBeNull();
    // 清单逐条对应运行器的真实校验，而不是只给一个布尔。
    const withEpisodes = (episodes: ComicDramaWorkflowOptions["episodes"]) =>
      comicDramaRequirements({ ...createComicDramaOptions(), episodes }).map((item) => item.field);
    expect(withEpisodes([{ id: "ep01", title: "第 1 集", script: "正文" }])).toEqual([]);
    expect(withEpisodes([{ id: "ep01", title: " ", script: " " }])).toEqual([
      "第 1 集集名",
      "第 1 集剧本",
    ]);
    expect(withEpisodes([])).toEqual(["分集剧本"]);
    expect(
      withEpisodes(
        Array.from({ length: 11 }, (_, index) => ({
          id: `ep${index + 1}`,
          title: `第 ${index + 1} 集`,
          script: "正文",
        })),
      ),
    ).toEqual(["集数"]);
    // 门槛函数与旧内联判断等价：至少一集且每集都有标题与剧本。
    expect(comicDramaInputReady(createComicDramaOptions())).toBe(false);
    expect(
      comicDramaInputReady({
        ...createComicDramaOptions(),
        episodes: [{ id: "ep01", title: "第 1 集", script: "正文" }],
      }),
    ).toBe(true);
  });

  it("imports sorted episode files and preserves existing episodes", async () => {
    function Harness() {
      const [options, setOptions] = useState<ComicDramaWorkflowOptions>({
        ...createComicDramaOptions(),
        episodes: [{ id: "existing", title: "序章", script: "序章正文" }],
      });
      return (
        <ComicDramaConfiguration
          options={options}
          brief=""
          disabled={false}
          onChange={setOptions}
          onBriefChange={vi.fn()}
        />
      );
    }
    const file = (name: string, script: string) => {
      const result = new File([script], name, { type: "text/plain" });
      Object.defineProperty(result, "text", { value: () => Promise.resolve(script) });
      return result;
    };
    render(<Harness />);
    fireEvent.click(screen.getByText("分集剧本与制作设置"));
    fireEvent.change(screen.getByLabelText("导入漫剧分集剧本"), {
      target: { files: [file("ep02.md", "第二集"), file("ep01.txt", "\uFEFF第一集")] },
    });
    await waitFor(() => expect(screen.getByLabelText("第 3 集剧本")).toHaveValue("第二集"));
    expect(screen.getByLabelText("第 1 集剧本")).toHaveValue("序章正文");
    expect(screen.getByLabelText("第 2 集剧本")).toHaveValue("第一集");
    expect(screen.getByLabelText("第 2 集集名")).toHaveValue("ep01");
  });

  it("shows per-episode checks and exports shared assets before image generation", () => {
    const source = node();
    const checkpoint = {
      ...source.config.checkpoint,
      comicDrama: {
        ...createComicDramaCheckpoint(),
        sharedAssets: [
          { id: "father", kind: "character" as const, name: "父亲", prompt: "蓝布衣修表匠" },
        ],
        episodes: [
          {
            id: "ep01",
            title: "第一集",
            script: "剧本",
            stages: {
              director: {
                artifact: {
                  content: "# P01 导演讲戏",
                  inputSummary: "本集剧本",
                  version: 1,
                  createdAt: 1,
                  assets: [],
                  shots: [],
                },
                businessReview: { result: "PASS" as const, report: "剧情点完整" },
                contentReview: {
                  result: "REVISE" as const,
                  report: "表达存在歧义",
                  repairInstructions: "明确动作对象",
                },
                passed: false,
                repairCount: 0,
                history: [],
              },
            },
          },
        ],
      },
    };
    const onExport = vi.fn();
    render(<ComicDramaDeliverables checkpoint={checkpoint} onExport={onExport} />);
    fireEvent.click(screen.getByText("第一集"));
    fireEvent.click(screen.getByText("导演分镜 · v1 · 待检查或修订"));
    expect(screen.getByText("业务检查 · 通过")).toBeInTheDocument();
    expect(screen.getByText("内容检查 · 待修订")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出漫剧制作文档" }));
    expect(onExport).toHaveBeenCalledTimes(1);
    const markdown = comicDramaDeliveryMarkdown(checkpoint);
    expect(markdown).toContain("蓝布衣修表匠");
    expect(markdown).toContain("待修订");
    expect(markdown).toContain("表达存在歧义");
    const bundle = comicDramaDeliveryBundle({
      ...checkpoint,
      comicDrama: {
        ...checkpoint.comicDrama,
        episodes: checkpoint.comicDrama.episodes.map((episode) => ({
          ...episode,
          title: '<script>alert("x")</script>',
        })),
      },
    });
    expect(bundle).toHaveLength(4);
    expect(bundle.map((file) => file.fileName)).toEqual([
      "01-分镜与制作文档.md",
      "02-审核记录.html",
      "03-成片报告.md",
      "04-全链总览.html",
    ]);
    expect(bundle[1]?.content).toContain("&lt;script&gt;");
    expect(bundle[1]?.content).not.toContain('<script>alert("x")</script>');
    expect(bundle[3]?.content).toContain("未批准");
    expect(bundle[2]?.content).toContain("非媒体实测");
  });
});
