import { describe, expect, it, vi } from "vitest";
import {
  workflowReferenceFixtures,
  workflowReferenceInputs,
} from "../../test/workflowMaterialFixtures";
import type {
  OptimizeVideoPromptCommand,
  VideoDownloadJobRecord,
  VideoDownloaderClient,
} from "../../lib/backend";
import type {
  ReverseVideoClient,
  ReverseVideoDelivery,
  ReverseVideoEvidence,
} from "../../lib/reverseVideo";
import { stableJsonSignature } from "../../lib/workflowSignatures";
import { catalog, node } from "../../test/videoWorkflowFixtures";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";
import {
  createReverseVideoOptions,
  reverseVideoDeliveryMarkdown,
  reverseVideoInputReady,
  reverseVideoSourceUrl,
  type ReverseVideoAnalysis,
} from "./reverseVideoWorkflowModel";
import {
  createReverseVideoWorkflowRunner,
  parseReverseVideoAnalysis,
  parseReverseVideoReview,
} from "./reverseVideoWorkflowRunner";

const analysis: ReverseVideoAnalysis = {
  schemaVersion: "reverse-video-analysis.v1",
  title: "庭院里的转身与挥手",
  summary:
    "10 秒，9:16 竖屏，单人、一个庭院、一镜到底；开端入画，发展前行，转折回头，结尾挥手定格；从平静到轻松。",
  dimensions: {
    subject: "一位成人",
    styling: "蓝色衬衫与深色长裤",
    scene: "石墙庭院",
    lighting: "左上方柔光",
    color: "青绿与灰白",
    camera: "缓慢跟拍后停止",
    composition: "中景，主体居右",
    emotion: "轻松",
    contentType: "生活短片",
    hook: "入画与石墙形成反差",
  },
  globalSettings:
    "角色：蓝衬衫深裤。场景：前景石路、中景人物、背景石墙。视觉：灰白与青绿。声音：音轨未提供，待听觉确认。",
  scenes: "场景 01，00:00.0—00:10.0，庭院入画与转身。",
  timeline: [
    {
      start: 0,
      end: 5,
      action: "向庭院前行",
      camera: "缓慢跟拍",
      audio: "待听觉确认，可建议脚步声",
      evidence: "全片 00:00—00:05 联系表",
    },
    {
      start: 5,
      end: 8,
      action: "停下后转身",
      camera: "停止平移",
      audio: "待听觉确认",
      evidence: "结尾 00:05—00:08 加密联系表",
    },
    {
      start: 8,
      end: 10,
      action: "抬手挥动后保持站姿",
      camera: "固定镜头",
      audio: "待听觉确认",
      evidence: "结尾 00:08—00:10 加密联系表",
    },
  ],
  ending: {
    beats: [
      {
        start: 5,
        end: 8,
        action: "停下后转身",
        camera: "停止平移",
        audio: "待听觉确认",
        evidence: "结尾第 1—18 帧",
      },
      {
        start: 8,
        end: 10,
        action: "抬手挥动后保持站姿",
        camera: "固定镜头",
        audio: "待听觉确认",
        evidence: "结尾第 19—31 帧",
      },
    ],
    finalFrame: "人物面向镜头，右手停在肩侧",
    evidence: "结尾 00:09.999 最后一格",
  },
  replicationPrompt:
    "10 秒，9:16 竖屏，一名穿蓝色衬衫的成人在石墙庭院中前行；5 秒停下转身，8 秒挥手，最后保持站姿。",
  viralDiagnosis: {
    hook: "人物入画形成反差",
    emotion: "轻松",
    memory: "挥手定格",
    replicable: "动作节拍与镜头停顿",
    replace: "主体身份与具体服饰",
  },
  remixes: ["skin", "viewpoint", "narrative"].map((route) => ({
    route: route as "skin" | "viewpoint" | "narrative",
    title: `二创 ${route}`,
    retained: "停下转身的动作结构",
    replaced: "替换人物和场景",
    prompt: `${route} 完整独立二创提示词。`,
    expectedEffect: "保留记忆点并形成差异",
    risk: "避免直接搬用原人物与原配乐",
  })),
  priority: "优先换皮，人物与场景变化清晰",
  pitfalls: ["音轨未经确认，二创采用自有配音"],
  keywords: ["转身", "挥手", "中景"],
  tags: ["生活", "庭院"],
};
const pass = { result: "PASS", report: "已逐格检查全片与结尾加密图，时间覆盖和动作一致。" };
const result = (value: object) =>
  Promise.resolve({
    optimizedPrompt: JSON.stringify(value),
    rawModelOutput: JSON.stringify(value),
  });
const engine = {
  state: "ready" as const,
  version: "project-engine",
  binaryPath: "C:\\app\\downloader.exe",
  cookiesInstalled: true,
  bilibiliLoggedIn: false,
  lastError: null,
};
function job(status: VideoDownloadJobRecord["status"], id = "download-1"): VideoDownloadJobRecord {
  return {
    jobId: id,
    url: "https://v.douyin.com/example/",
    status,
    progress: status === "completed" ? 100 : 20,
    finalPath: status === "completed" ? "C:\\downloads\\source.mp4" : null,
    fileName: status === "completed" ? "source.mp4" : null,
    qualityMode: null,
    qualityHint: null,
    watermarkRemoved: false,
    error: status === "failed" ? "请检查下载器登录配置" : null,
    createdAt: 1,
    updatedAt: 2,
  };
}
const evidence: ReverseVideoEvidence = {
  duration: 10,
  width: 1080,
  height: 1920,
  overviewFrameCount: 21,
  tailFrameCount: 31,
  sheets: [
    {
      localPath: "C:\\evidence\\overview.jpg",
      displayName: "全片 00:00—00:10",
      phase: "overview",
      firstTime: 0,
      lastTime: 9.999,
      frameCount: 21,
    },
    {
      localPath: "C:\\evidence\\tail.jpg",
      displayName: "结尾 00:05—00:10",
      phase: "tail",
      firstTime: 5,
      lastTime: 9.999,
      frameCount: 31,
    },
  ],
  representativeFrames: [
    { localPath: "C:\\evidence\\frame.jpg", displayName: "最终画面", time: 9.999 },
  ],
};
const delivery: ReverseVideoDelivery = {
  caseId: "case-1",
  directory: "C:\\delivery",
  videoPath: "C:\\delivery\\video.mp4",
  markdownPath: "C:\\delivery\\反推提示词.md",
  textPath: "C:\\delivery\\反推提示词.txt",
  casePath: "C:\\delivery\\case.json",
  caseCount: 7,
};

function setup() {
  const downloader: VideoDownloaderClient = {
    getEngine: vi.fn(() => Promise.resolve(engine)),
    installEngine: vi.fn(() => Promise.resolve(engine)),
    updateEngine: vi.fn(() => Promise.resolve(engine)),
    importCookies: vi.fn(() => Promise.resolve(engine)),
    clearCookies: vi.fn(() => Promise.resolve(engine)),
    startDownload: vi.fn(() => Promise.resolve(job("downloading"))),
    getJob: vi.fn(() => Promise.resolve(job("completed"))),
    cancelJob: vi.fn(() => Promise.resolve(job("cancelled"))),
  };
  const artifacts = {
    saveEvidence: vi.fn<ReverseVideoClient["saveEvidence"]>(() => Promise.resolve(evidence)),
    getLearning: vi.fn(() =>
      Promise.resolve({ caseCount: 6, summary: "已有案例常见跟拍结构；仅统计真实已归档案例。" }),
    ),
    deliver: vi.fn<ReverseVideoClient["deliver"]>(() => Promise.resolve(delivery)),
  } satisfies ReverseVideoClient;
  const samples = {
    ...evidence,
    sheets: evidence.sheets.map((sheet) => ({
      displayName: sheet.displayName,
      phase: sheet.phase!,
      firstTime: sheet.firstTime!,
      lastTime: sheet.lastTime!,
      frameCount: sheet.frameCount!,
      dataUrl: "data:image/jpeg;base64,aW1hZ2U=",
    })),
    representativeFrames: [
      { dataUrl: "data:image/jpeg;base64,aW1hZ2U=", displayName: "最终画面", time: 9.999 },
    ],
  };
  const sample = vi.fn(() => Promise.resolve(samples));
  const normalResponse = (command: OptimizeVideoPromptCommand) =>
    result(command.mode === "reverse_video_analysis" ? analysis : pass);
  const promptClient = { run: vi.fn(normalResponse) };
  const source = node();
  const reverseNode: KnowledgeVideoWorkflowNodeData = {
    ...source,
    config: {
      ...source.config,
      brief: "",
      reverseVideo: {
        ...createReverseVideoOptions(),
        sourceUrl: "分享： https://v.douyin.com/example/ 来看看这个视频。",
      },
    },
  };
  const runner = createReverseVideoWorkflowRunner({
    promptClient,
    downloader,
    artifacts,
    sample,
    now: () => 42,
    createId: () => "79304e4b-c077-4f12-aeab-535180d29612",
    sleep: vi.fn(() => Promise.resolve()),
  });
  const request = {
    node: reverseNode,
    providerCatalog: catalog,
    signal: new AbortController().signal,
    onCheckpoint: vi.fn(),
    onProgress: vi.fn(),
  };
  const resume = (checkpoint: KnowledgeVideoWorkflowCheckpoint) => ({
    ...request,
    resume: true,
    node: { ...reverseNode, config: { ...reverseNode.config, checkpoint } },
  });
  return {
    downloader,
    artifacts,
    sample,
    samples,
    promptClient,
    normalResponse,
    runner,
    request,
    resume,
  };
}

describe("reverse video workflow", () => {
  it("reads every general reference in planning and independent reviews and rejects changed resume inputs", async () => {
    const { runner, request, promptClient } = setup();
    const withMaterials = {
      ...request,
      node: {
        ...request.node,
        config: { ...request.node.config, materials: workflowReferenceFixtures },
      },
    };
    const checkpoint = await runner.run(withMaterials);
    expect(checkpoint.phase).toBe("done");
    const calls = vi.mocked(promptClient.run).mock.calls.map(([input]) => input);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const input of calls) expect(input.multimodalInputs).toEqual(workflowReferenceInputs);
    vi.mocked(promptClient.run).mockClear();
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
    expect(promptClient.run).not.toHaveBeenCalled();
  });

  it("downloads through the project engine, reads actual local contact sheets, reviews, and delivers all artifacts", async () => {
    const run = setup();
    const checkpoint = await run.runner.run(run.request);
    expect(checkpoint.phase).toBe("done");
    expect(checkpoint.reverseVideo?.delivery).toEqual(delivery);
    expect(checkpoint.finalPath).toBe(delivery.videoPath);
    expect(run.downloader.startDownload).toHaveBeenCalledExactlyOnceWith(
      "https://v.douyin.com/example/",
    );
    expect(run.artifacts.saveEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1080,
        height: 1920,
        representativeFrames: run.samples.representativeFrames,
      }),
    );
    expect(JSON.stringify(checkpoint)).not.toContain("data:image");
    expect(run.promptClient.run).toHaveBeenCalledTimes(2);
    for (const [command] of run.promptClient.run.mock.calls) {
      expect(command.providerConnectionId).toBe("project-provider");
      expect(command.visionImages).toEqual(
        evidence.sheets.map((sheet) => ({
          target: { kind: "local_file", path: sheet.localPath, mediaType: "image" },
          displayName: sheet.displayName,
        })),
      );
      expect(command.multimodalInputs).toBeUndefined();
      expect(command.userPrompt).toContain("已有案例常见跟拍结构");
      expect(command.userPrompt).toContain("未传入音轨");
    }
    const archive = vi.mocked(run.artifacts.deliver).mock.calls[0]![0];
    expect(archive.markdown).toContain("结尾五秒逐动作核对");
    expect(archive.markdown).toContain("声音项均为待听觉确认");
    expect(archive.promptText).toContain("skin 完整独立二创提示词");
    expect(archive.promptText).toContain("viewpoint 完整独立二创提示词");
    expect(archive.promptText).toContain("narrative 完整独立二创提示词");
    expect(archive.promptText).toContain("不新增人物、道具、文字、标识或水印");
    expect(run.downloader.importCookies).not.toHaveBeenCalled();
  });

  it("accepts a local video without requesting the downloader or requiring a brief", async () => {
    const run = setup();
    const request = {
      ...run.request,
      node: {
        ...run.request.node,
        config: {
          ...run.request.node.config,
          reverseVideo: {
            sourceUrl: "",
            localVideoPath: "C:\\local\\clip.mp4",
            localVideoName: "clip.mp4",
          },
        },
      },
    };
    const checkpoint = await run.runner.run(request);
    expect(checkpoint.phase).toBe("done");
    expect(checkpoint.reverseVideo?.videoPath).toBe("C:\\local\\clip.mp4");
    expect(run.downloader.getEngine).not.toHaveBeenCalled();
    expect(run.downloader.startDownload).not.toHaveBeenCalled();
    expect(run.sample).toHaveBeenCalledWith("C:\\local\\clip.mp4", request.signal);
  });

  it("installs the existing project download engine before starting a download", async () => {
    const run = setup();
    vi.mocked(run.downloader.getEngine).mockResolvedValueOnce({
      ...engine,
      state: "not_installed",
    });
    expect((await run.runner.run(run.request)).phase).toBe("done");
    expect(run.downloader.installEngine).toHaveBeenCalledTimes(1);
  });

  it("resumes a fully completed, reordered persisted snapshot without repeating any work", async () => {
    const run = setup();
    const checkpoint = await run.runner.run(run.request);
    const reordered = JSON.parse(
      stableJsonSignature(checkpoint),
    ) as KnowledgeVideoWorkflowCheckpoint;
    expect((await run.runner.run(run.resume(reordered))).phase).toBe("done");
    expect(run.promptClient.run).toHaveBeenCalledTimes(2);
    expect(run.artifacts.deliver).toHaveBeenCalledTimes(1);
    expect(run.downloader.startDownload).toHaveBeenCalledTimes(1);
  });

  it("retries only artifact delivery after an archive failure and keeps the learning snapshot", async () => {
    const run = setup();
    vi.mocked(run.artifacts.deliver).mockRejectedValueOnce(new Error("磁盘暂时不可写"));
    const failed = await run.runner.run(run.request);
    expect(failed.phase).toBe("failed");
    expect(failed.reverseVideo?.step).toBe("archive");
    expect(failed.reverseVideo?.review?.result).toBe("PASS");
    const resumed = await run.runner.run(run.resume(failed));
    expect(resumed.phase).toBe("done");
    expect(run.promptClient.run).toHaveBeenCalledTimes(2);
    expect(run.sample).toHaveBeenCalledTimes(1);
    expect(run.artifacts.getLearning).toHaveBeenCalledTimes(1);
    expect(run.artifacts.deliver).toHaveBeenCalledTimes(2);
  });

  it("queries the original download after a transient status failure without starting another", async () => {
    const run = setup();
    vi.mocked(run.downloader.getJob).mockRejectedValueOnce(new Error("查询暂时失败"));
    const failed = await run.runner.run(run.request);
    expect(failed.phase).toBe("failed");
    expect(failed.reverseVideo?.downloadJobId).toBe("download-1");
    expect(run.promptClient.run).not.toHaveBeenCalled();
    expect((await run.runner.run(run.resume(failed))).phase).toBe("done");
    expect(run.downloader.startDownload).toHaveBeenCalledTimes(1);
    expect(run.downloader.getJob).toHaveBeenLastCalledWith("download-1");
  });

  it("restarts only a download explicitly missing after application restart", async () => {
    const run = setup();
    vi.mocked(run.downloader.getJob).mockRejectedValueOnce({
      kind: "protocol",
      message: "查询暂时失败",
    });
    const failed = await run.runner.run(run.request);
    expect(failed.reverseVideo?.downloadJobId).toBe("download-1");
    vi.mocked(run.downloader.getJob).mockRejectedValueOnce({
      kind: "not_found",
      message: "video download job not found",
    });
    vi.mocked(run.downloader.startDownload).mockResolvedValueOnce(
      job("completed", "download-after-restart"),
    );
    const resumed = await run.runner.run(run.resume(failed));
    expect(resumed.phase).toBe("done");
    expect(resumed.reverseVideo?.downloadJobId).toBe("download-after-restart");
    expect(run.downloader.startDownload).toHaveBeenCalledTimes(2);
    expect(run.request.onProgress).toHaveBeenCalledWith({
      phase: "planning",
      progress: 4,
      error: null,
      message: "旧下载任务在重启后已不存在，正在用项目下载器重新获取原视频…",
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "allows an explicit retry after a confirmed %s download",
    async (status) => {
      const run = setup();
      vi.mocked(run.downloader.startDownload).mockResolvedValueOnce(job(status));
      const failed = await run.runner.run(run.request);
      expect(failed.phase).toBe("failed");
      expect(failed.reverseVideo?.downloadJobId).toBe("download-1");
      vi.mocked(run.downloader.getJob).mockResolvedValueOnce(job(status));
      expect((await run.runner.run(run.resume(failed))).phase).toBe("done");
      expect(run.downloader.startDownload).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps downloaded evidence when a text-only provider rejects images and resumes after changing the model", async () => {
    const run = setup();
    run.promptClient.run.mockRejectedValueOnce(
      new Error("HTTP 400: model does not support image input"),
    );
    const failed = await run.runner.run(run.request);
    expect(failed.phase).toBe("failed");
    expect(failed.error).toContain("需要切换到支持读图的多模态模型");
    expect(failed.reverseVideo?.videoPath).toBeTruthy();
    expect(failed.reverseVideo?.evidence).toEqual(evidence);
    expect(failed.reverseVideo?.analysis).toBeNull();
    expect(reverseVideoDeliveryMarkdown(failed)).toContain("待视觉确认");
    expect(run.artifacts.deliver).not.toHaveBeenCalled();
    const request = run.resume(failed);
    const replacementCatalog = catalog.map((entry) => ({
      ...entry,
      models: [
        ...entry.models,
        {
          ...entry.models.find((model) => model.definitionId === "project-text")!,
          definitionId: "project-vision",
        },
      ],
    }));
    const completed = await run.runner.run({
      ...request,
      providerCatalog: replacementCatalog,
      node: {
        ...request.node,
        config: {
          ...request.node.config,
          models: {
            ...request.node.config.models,
            text: { providerId: "project-provider", modelDefinitionId: "project-vision" },
          },
        },
      },
    });
    expect(completed.phase).toBe("done");
    expect(run.promptClient.run).toHaveBeenCalledTimes(3);
    expect(run.sample).toHaveBeenCalledTimes(1);
    expect(run.downloader.startDownload).toHaveBeenCalledTimes(1);
    expect(run.promptClient.run.mock.lastCall?.[0].modelDefinitionId).toBe("project-vision");
  });

  it("repairs a failed visual review using actual images and runs another independent review", async () => {
    const run = setup();
    let checks = 0;
    run.promptClient.run.mockImplementation((command) =>
      command.mode === "reverse_video_review" && ++checks === 1
        ? result({
            result: "REVISE",
            report: "结尾需要区分抬手与挥动",
            repairInstructions: "把 8—10 秒拆成抬手、挥动、最终停姿",
          })
        : run.normalResponse(command),
    );
    const checkpoint = await run.runner.run(run.request);
    expect(checkpoint.phase).toBe("done");
    expect(checkpoint.reverseVideo?.repairCount).toBe(1);
    expect(checkpoint.reverseVideo?.history).toHaveLength(1);
    expect(run.promptClient.run).toHaveBeenCalledTimes(4);
    expect(run.promptClient.run.mock.calls[2]![0].userPrompt).toContain("把 8—10 秒拆成抬手");
    expect(run.promptClient.run.mock.calls[3]![0].visionImages).toHaveLength(2);
  });

  it("requires a real decision and then revises and rechecks; resuming alone cannot bypass review", async () => {
    const run = setup();
    let checks = 0;
    run.promptClient.run.mockImplementation((command) =>
      command.mode === "reverse_video_review" && ++checks === 1
        ? result({
            result: "NEEDS_DECISION",
            report: "人物手中物体无法确认",
            question: "是否将不清晰道具改为无道具版本？",
            recommendation: "改为无道具动作",
          })
        : run.normalResponse(command),
    );
    const pending = await run.runner.run(run.request);
    expect(pending.phase).toBe("awaiting_approval");
    expect(run.artifacts.deliver).not.toHaveBeenCalled();
    expect((await run.runner.run(run.resume(pending))).phase).toBe("awaiting_approval");
    expect(run.promptClient.run).toHaveBeenCalledTimes(2);
    const completed = await run.runner.run({
      ...run.resume(pending),
      decisionResolution: "改为无道具动作",
    });
    expect(completed.phase).toBe("done");
    expect(run.promptClient.run).toHaveBeenCalledTimes(4);
    for (const [command] of run.promptClient.run.mock.calls.slice(2))
      expect(command.userPrompt).toContain("用户决定：改为无道具动作");
    expect(completed.reverseVideo?.confirmedDecisions).toHaveLength(1);
  });

  it("stops at the configured automatic retry limit without silently accepting the failed review", async () => {
    const run = setup();
    run.promptClient.run.mockImplementation((command) =>
      command.mode === "reverse_video_review"
        ? result({
            result: "REVISE",
            report: "结尾证据不足",
            repairInstructions: "重新明确转身位置",
          })
        : run.normalResponse(command),
    );
    const checkpoint = await run.runner.run({
      ...run.request,
      node: { ...run.request.node, config: { ...run.request.node.config, maxAutomaticRetries: 0 } },
    });
    expect(checkpoint.phase).toBe("awaiting_approval");
    expect(checkpoint.decision?.question).toContain("自动修订上限");
    expect(run.promptClient.run).toHaveBeenCalledTimes(2);
    expect(run.artifacts.deliver).not.toHaveBeenCalled();
  });

  it("automatically removes generated external jumps through a corrective model request before review or delivery", async () => {
    const run = setup();
    run.promptClient.run.mockResolvedValueOnce({
      optimizedPrompt: JSON.stringify({
        ...analysis,
        replicationPrompt: "去 https://external.example/downloader 下载再处理",
      }),
      rawModelOutput: "",
    });
    const completed = await run.runner.run(run.request);
    expect(completed.phase).toBe("done");
    expect(run.promptClient.run).toHaveBeenCalledTimes(3);
    expect(run.promptClient.run.mock.calls[1]![0].userPrompt).toContain(
      "不能包含网站链接或跳转操作",
    );
    expect(vi.mocked(run.artifacts.deliver).mock.calls[0]![0].markdown).not.toContain(
      "external.example",
    );
  });

  it("blocks source changes on resume while preserving prior completed artifacts", async () => {
    const run = setup();
    const checkpoint = await run.runner.run(run.request);
    const request = run.resume(checkpoint);
    const changed = await run.runner.run({
      ...request,
      node: { ...request.node, config: { ...request.node.config, brief: "新的补充要求" } },
    });
    expect(changed.phase).toBe("failed");
    expect(changed.error).toContain("来源或补充要求已修改");
    expect(changed.reverseVideo?.delivery).toEqual(delivery);
    expect(run.promptClient.run).toHaveBeenCalledTimes(2);
  });

  it("does not start a download if pause arrives while the engine is being checked", async () => {
    const run = setup(),
      controller = new AbortController();
    vi.mocked(run.downloader.getEngine).mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(engine);
    });
    const checkpoint = await run.runner.run({ ...run.request, signal: controller.signal });
    expect(checkpoint.phase).toBe("paused");
    expect(run.downloader.startDownload).not.toHaveBeenCalled();
    expect(run.sample).not.toHaveBeenCalled();
  });

  it("retains a download identity returned during pause and queries it on resume", async () => {
    const run = setup(),
      controller = new AbortController();
    vi.mocked(run.downloader.startDownload).mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(job("downloading"));
    });
    const paused = await run.runner.run({ ...run.request, signal: controller.signal });
    expect(paused.phase).toBe("paused");
    expect(paused.reverseVideo?.downloadJobId).toBe("download-1");
    expect(run.downloader.getJob).not.toHaveBeenCalled();
    expect((await run.runner.run(run.resume(paused))).phase).toBe("done");
    expect(run.downloader.startDownload).toHaveBeenCalledTimes(1);
  });

  it("does not persist new evidence or call a model after pause arrives during frame extraction", async () => {
    const run = setup(),
      controller = new AbortController();
    run.sample.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(run.samples);
    });
    const paused = await run.runner.run({ ...run.request, signal: controller.signal });
    expect(paused.phase).toBe("paused");
    expect(paused.reverseVideo?.videoPath).toBeTruthy();
    expect(run.artifacts.saveEvidence).not.toHaveBeenCalled();
    expect(run.promptClient.run).not.toHaveBeenCalled();
  });

  it("retains evidence returned during pause and does not repeat extraction on resume", async () => {
    const run = setup(),
      controller = new AbortController();
    vi.mocked(run.artifacts.saveEvidence).mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(evidence);
    });
    const paused = await run.runner.run({ ...run.request, signal: controller.signal });
    expect(paused.phase).toBe("paused");
    expect(paused.reverseVideo?.evidence).toEqual(evidence);
    expect(run.promptClient.run).not.toHaveBeenCalled();
    expect((await run.runner.run(run.resume(paused))).phase).toBe("done");
    expect(run.sample).toHaveBeenCalledTimes(1);
    expect(run.artifacts.saveEvidence).toHaveBeenCalledTimes(1);
  });
});

describe("reverse video source and output contracts", () => {
  it("accepts one link in share text and rejects several links or conflicting inputs", () => {
    expect(reverseVideoSourceUrl("复制打开 https://v.douyin.com/example/ 看看")).toBe(
      "https://v.douyin.com/example/",
    );
    expect(reverseVideoSourceUrl("https://a.example/ https://b.example/")).toBeNull();
    expect(
      reverseVideoInputReady("", {
        ...createReverseVideoOptions(),
        sourceUrl: "https://a.example/",
      }),
    ).toBe(true);
    expect(
      reverseVideoInputReady("", {
        sourceUrl: "https://a.example/",
        localVideoPath: "C:\\a.mp4",
        localVideoName: "a.mp4",
      }),
    ).toBe(false);
    expect(reverseVideoInputReady("主题不能代替视频", createReverseVideoOptions())).toBe(false);
  });

  it("validates coverage of actual duration, ending actions, camera/audio evidence, and three distinct routes", () => {
    expect(parseReverseVideoAnalysis(JSON.stringify(analysis), 10)).toEqual(analysis);
    expect(() =>
      parseReverseVideoAnalysis(
        JSON.stringify({ ...analysis, ending: { ...analysis.ending, beats: [] } }),
        10,
      ),
    ).toThrow("不能留空");
    expect(() =>
      parseReverseVideoAnalysis(
        JSON.stringify({
          ...analysis,
          timeline: [{ ...analysis.timeline[0], end: 4 }, ...analysis.timeline.slice(1)],
        }),
        10,
      ),
    ).toThrow("不能漏掉动作");
    expect(() =>
      parseReverseVideoAnalysis(
        JSON.stringify({
          ...analysis,
          timeline: [{ ...analysis.timeline[0], camera: "" }, ...analysis.timeline.slice(1)],
        }),
        10,
      ),
    ).toThrow("camera");
    expect(() =>
      parseReverseVideoAnalysis(
        JSON.stringify({
          ...analysis,
          remixes: [analysis.remixes[0], analysis.remixes[0], analysis.remixes[2]],
        }),
        10,
      ),
    ).toThrow("不能重复");
    expect(() => parseReverseVideoAnalysis(JSON.stringify(analysis), 20)).toThrow();
    expect(() =>
      parseReverseVideoReview(JSON.stringify({ result: "REVISE", report: "有误" })),
    ).toThrow("repairInstructions");
    expect(() =>
      parseReverseVideoReview(
        JSON.stringify({ result: "PASS", report: "可去 https://outside.example 查看详情" }),
      ),
    ).toThrow("不能包含网站链接");
  });
});
