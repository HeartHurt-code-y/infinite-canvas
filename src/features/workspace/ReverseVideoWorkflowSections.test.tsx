import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { catalog, node } from "../../test/videoWorkflowFixtures";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import {
  ReverseVideoConfiguration,
  ReverseVideoDeliverables,
} from "./ReverseVideoWorkflowSections";
import { revealDesktopItem } from "./desktopActions";
import {
  createReverseVideoCheckpoint,
  createReverseVideoOptions,
  type ReverseVideoAnalysis,
} from "./reverseVideoWorkflowModel";
import type {
  KnowledgeVideoWorkflowCheckpoint,
  KnowledgeVideoWorkflowNodeData,
} from "./workspaceModel";

vi.mock("./desktopActions", () => ({ revealDesktopItem: vi.fn(async () => {}) }));

const sourceUrl = "看看这个视频 https://v.douyin.com/example/";
const videoPath = "C:\\videos\\原片.mp4";
const analysis: ReverseVideoAnalysis = {
  schemaVersion: "reverse-video-analysis.v1",
  title: "厨房倒水动作反推",
  summary: "同一人物在厨房拿起水杯后倒水。",
  dimensions: {
    subject: "一位人物",
    styling: "白色上衣与透明杯",
    scene: "厨房",
    lighting: "窗边自然光",
    color: "暖白色",
    camera: "固定机位",
    composition: "中近景",
    emotion: "轻松",
    contentType: "生活记录",
    hook: "拿起水杯",
  },
  globalSettings: "保持同一人物、服装和空间方位。",
  scenes: "厨房台面。",
  timeline: [
    {
      start: 0,
      end: 5,
      action: "拿起水杯",
      camera: "固定",
      audio: "待确认",
      evidence: "全片联系表",
    },
  ],
  ending: {
    beats: [
      {
        start: 5,
        end: 10,
        action: "放下水杯",
        camera: "固定",
        audio: "待确认",
        evidence: "尾部联系表",
      },
    ],
    finalFrame: "水杯放回台面",
    evidence: "9.99 秒实际帧",
  },
  replicationPrompt: "让同一人物拿起水杯，缓慢倒水，最后放回台面。",
  viralDiagnosis: {
    hook: "动作起手",
    emotion: "轻松",
    memory: "放下杯子",
    replicable: "动作结构",
    replace: "场景",
  },
  remixes: [
    {
      route: "skin",
      title: "宠物用品",
      retained: "拿起与放下",
      replaced: "水杯换成食盆",
      prompt: "拿起食盆后放下",
      expectedEffect: "突出用品",
      risk: "保持道具一致",
    },
  ],
  priority: "先尝试换皮。",
  pitfalls: ["避免道具跳变"],
  keywords: ["厨房", "连续动作"],
  tags: ["生活"],
};

function reverseNode(
  phase: KnowledgeVideoWorkflowCheckpoint["phase"] = "idle",
): KnowledgeVideoWorkflowNodeData {
  const base = node();
  return {
    ...base,
    config: {
      ...base.config,
      brief: "",
      reverseVideo: { ...createReverseVideoOptions(), sourceUrl },
      models: {
        ...base.config.models,
        image: { providerId: "", modelDefinitionId: "" },
        video: { providerId: "", modelDefinitionId: "" },
      },
      checkpoint: {
        ...base.config.checkpoint,
        phase,
        reverseVideo: createReverseVideoCheckpoint(),
      },
    },
  };
}

function nodeProps(workflowNode = reverseNode()) {
  return {
    node: workflowNode,
    providerCatalog: catalog,
    onChange: vi.fn(),
    onExecute: vi.fn(),
    onContinue: vi.fn(),
    onCancel: vi.fn(),
    onRemove: vi.fn(),
    onRevealResult: vi.fn(),
    onPickReverseVideo: vi.fn(async () => {}),
    onRemoveReverseVideo: vi.fn(),
    onOpenDownloadSettings: vi.fn(),
    onOpenHistory: vi.fn(),
  };
}

function completedCheckpoint(): KnowledgeVideoWorkflowCheckpoint {
  return {
    ...reverseNode("done").config.checkpoint,
    reverseVideo: {
      ...createReverseVideoCheckpoint(),
      step: "done",
      videoPath,
      analysis,
      evidence: {
        duration: 10,
        width: 1080,
        height: 1920,
        overviewFrameCount: 10,
        tailFrameCount: 11,
        sheets: [
          {
            localPath: "C:\\videos\\overview.jpg",
            displayName: "全片联系表",
            phase: "overview",
            firstTime: 0,
            lastTime: 9.99,
            frameCount: 10,
          },
          {
            localPath: "C:\\videos\\tail.jpg",
            displayName: "结尾联系表",
            phase: "tail",
            firstTime: 5,
            lastTime: 9.99,
            frameCount: 11,
          },
        ],
        representativeFrames: [
          { localPath: "C:\\videos\\last.jpg", displayName: "最后一帧", time: 9.99 },
        ],
      },
      review: { result: "PASS", report: "尾部动作和道具连续性通过核对。" },
      learning: { caseCount: 2, summary: "两条案例均显示动作连续性需要核对。" },
      delivery: {
        caseId: "case-3",
        directory: "C:\\deliveries\\case-3",
        videoPath,
        markdownPath: "C:\\deliveries\\case-3\\analysis.md",
        textPath: "C:\\deliveries\\case-3\\prompt.txt",
        casePath: "C:\\deliveries\\case-3\\case.json",
        caseCount: 3,
      },
    },
  };
}

describe("ReverseVideoConfiguration", () => {
  it("switches share messages and local video through project pickers without ambiguous sources", async () => {
    const pick = vi.fn(async () => {});
    const login = vi.fn();
    function Harness() {
      const [options, setOptions] = useState({ ...createReverseVideoOptions(), sourceUrl });
      return (
        <ReverseVideoConfiguration
          options={options}
          brief=""
          disabled={false}
          onChange={setOptions}
          onBriefChange={vi.fn()}
          onOpenDownloadSettings={login}
          onPickVideo={async () => {
            await pick();
            setOptions({ sourceUrl: "", localVideoPath: videoPath, localVideoName: "原片.mp4" });
          }}
          onRemoveVideo={() => setOptions(createReverseVideoOptions())}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByLabelText("反推视频分享链接")).toHaveValue(sourceUrl);
    fireEvent.click(screen.getByRole("button", { name: "导入下载登录凭据" }));
    expect(login).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "改用本地视频" }));
    await screen.findByText("原片.mp4");
    expect(pick).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("反推视频分享链接")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导入下载登录凭据" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除本地视频" }));
    expect(screen.getByLabelText("反推视频分享链接")).toHaveValue("");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("publishes Chinese composition only after confirmation and locks running inputs", () => {
    const onChange = vi.fn();
    const onBriefChange = vi.fn();
    const props = {
      options: createReverseVideoOptions(),
      brief: "",
      disabled: false,
      onChange,
      onBriefChange,
      onPickVideo: vi.fn(),
    };
    const { rerender } = render(<ReverseVideoConfiguration {...props} />);
    for (const [name, callback] of [
      ["反推视频分享链接", onChange],
      ["反推补充方向", onBriefChange],
    ] as const) {
      const input = screen.getByLabelText(name);
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: "ri'ben" } });
      expect(callback).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "日本" } });
      fireEvent.compositionEnd(input, { data: "日本" });
      expect(callback).toHaveBeenCalledOnce();
    }
    expect(onChange).toHaveBeenCalledWith({
      sourceUrl: "日本",
      localVideoPath: "",
      localVideoName: "",
    });
    expect(onBriefChange).toHaveBeenCalledWith("日本");
    rerender(<ReverseVideoConfiguration {...props} disabled />);
    expect(screen.getByLabelText("反推视频分享链接")).toBeDisabled();
    expect(screen.getByLabelText("反推补充方向")).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择本地视频" })).toBeDisabled();
  });

  it("reports native picker errors without losing the share text", async () => {
    render(
      <ReverseVideoConfiguration
        options={{ ...createReverseVideoOptions(), sourceUrl }}
        brief=""
        disabled={false}
        onChange={vi.fn()}
        onBriefChange={vi.fn()}
        onPickVideo={() => Promise.reject(new Error("视频文件无法读取"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "改用本地视频" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("视频文件无法读取");
    expect(screen.getByLabelText("反推视频分享链接")).toHaveValue(sourceUrl);
  });
});

describe("reverse-video workflow node", () => {
  it("requires only a project text model and a video, while preserving history and download controls", () => {
    const props = nodeProps();
    render(<KnowledgeVideoWorkflowNode {...props} />);
    expect(screen.getByText("短视频反推工作流")).toBeInTheDocument();
    expect(screen.queryByLabelText("图片生成模型")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("视频生成模型")).not.toBeInTheDocument();
    expect(screen.getByLabelText("视觉反推与审核模型")).toHaveValue("project-text");
    expect(screen.getByRole("button", { name: "开始反推" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "开始反推" }));
    expect(props.onExecute).toHaveBeenCalledWith(props.node.key);
    fireEvent.click(screen.getByRole("button", { name: "查看短视频反推工作流历史记录" }));
    expect(props.onOpenHistory).toHaveBeenCalledWith(props.node.key);
    fireEvent.click(screen.getByRole("button", { name: "导入下载登录凭据" }));
    expect(props.onOpenDownloadSettings).toHaveBeenCalledWith(props.node.key);
  });

  it("requires an unambiguous single source before submitting analysis", () => {
    const props = nodeProps();
    const { rerender } = render(
      <KnowledgeVideoWorkflowNode
        {...props}
        node={{
          ...props.node,
          config: {
            ...props.node.config,
            reverseVideo: {
              ...createReverseVideoOptions(),
              sourceUrl: `${sourceUrl} https://v.douyin.com/second/`,
            },
          },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "开始反推" })).toBeDisabled();
    rerender(
      <KnowledgeVideoWorkflowNode
        {...props}
        node={{
          ...props.node,
          config: {
            ...props.node.config,
            reverseVideo: { sourceUrl, localVideoPath: videoPath, localVideoName: "原片.mp4" },
          },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "开始反推" })).toBeDisabled();
  });

  it("keeps the review step selected while forwarding a confirmed decision for rechecking", () => {
    const props = nodeProps(reverseNode("awaiting_approval"));
    const workflowNode = {
      ...props.node,
      config: {
        ...props.node.config,
        checkpoint: {
          ...props.node.config.checkpoint,
          decision: {
            kind: "qc" as const,
            question: "手持物体是否为水杯？",
            recommendation: "确认物体后继续核对。",
          },
          reverseVideo: { ...createReverseVideoCheckpoint(), step: "review" as const },
        },
      },
    };
    render(<KnowledgeVideoWorkflowNode {...props} node={workflowNode} />);
    expect(screen.getByText("校验").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByLabelText("反推补充方向")).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "你的回答（可选）" }), {
      target: { value: "确认是水杯" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认后修订并重检" }));
    expect(props.onContinue).toHaveBeenCalledWith(workflowNode.key, "确认是水杯");
  });

  it("locks active inputs, shows automatic stages and offers pause then breakpoint retry", () => {
    const props = nodeProps(reverseNode("generating"));
    const { rerender } = render(<KnowledgeVideoWorkflowNode {...props} />);
    expect(screen.getByLabelText("反推补充方向")).toBeDisabled();
    expect(screen.getByLabelText("视觉反推与审核模型")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "开始反推" })).not.toBeInTheDocument();
    expect(screen.getByText("下载与抽帧")).toBeInTheDocument();
    expect(screen.getByText("入库")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂停后续步骤" }));
    expect(props.onCancel).toHaveBeenCalledWith(props.node.key);
    const failed = reverseNode("failed");
    rerender(
      <KnowledgeVideoWorkflowNode
        {...props}
        node={{
          ...failed,
          config: {
            ...failed.config,
            checkpoint: { ...failed.config.checkpoint, error: "下载器登录凭据已失效" },
          },
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("下载器登录凭据已失效");
    expect(screen.getByText(/下载未完成/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试当前步骤" }));
    expect(props.onContinue).toHaveBeenCalledWith(props.node.key);
  });
});

describe("ReverseVideoDeliverables", () => {
  it("shows actual frames, all analysis sections and persisted case counts with local file actions", async () => {
    const checkpoint = completedCheckpoint();
    render(<ReverseVideoDeliverables checkpoint={checkpoint} />);
    expect(screen.getByText("反推交付物已就绪")).toBeInTheDocument();
    expect(screen.getByText("反推提示词与二创路线").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("反推提示词与二创路线"));
    for (const heading of [
      "一、视频结构摘要",
      "二、全片设定",
      "三、分场设定",
      "四、分镜生成稿",
      "三条二创路线",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByRole("status")).toHaveTextContent("本次入库后共 3 条案例");
    fireEvent.click(screen.getByText("抽帧联系表 · 全片 10 帧 / 尾部 11 帧"));
    expect(screen.getByRole("img", { name: "最后一帧" })).toHaveAttribute(
      "src",
      expect.stringContaining("last.jpg"),
    );
    expect(screen.getByRole("img", { name: "结尾联系表" })).toHaveAttribute(
      "src",
      expect.stringContaining("tail.jpg"),
    );
    expect(screen.getByText("结尾联系表 · 5.00—9.99 秒 · 11 帧")).toBeInTheDocument();
    fireEvent.click(screen.getByText("原片预览"));
    expect(screen.getByLabelText("反推原片预览")).toHaveAttribute(
      "src",
      expect.stringContaining(".mp4"),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看 Markdown 文件" }));
    await waitFor(() =>
      expect(revealDesktopItem).toHaveBeenCalledWith(
        checkpoint.reverseVideo!.delivery!.markdownPath,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看 TXT 文件" }));
    await waitFor(() =>
      expect(revealDesktopItem).toHaveBeenCalledWith(checkpoint.reverseVideo!.delivery!.textPath),
    );
  });

  it("does not claim archival or expose nonexistent document files before delivery", () => {
    const checkpoint = completedCheckpoint();
    render(
      <ReverseVideoDeliverables
        checkpoint={{
          ...checkpoint,
          phase: "qc",
          reverseVideo: { ...checkpoint.reverseVideo!, delivery: null },
        }}
      />,
    );
    expect(screen.queryByText("案例已入库")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看 Markdown 文件" })).not.toBeInTheDocument();
    expect(
      screen.getByText("本次已参考案例库中的 2 条案例，完成校验后保存本次案例。"),
    ).toBeInTheDocument();
  });
});
