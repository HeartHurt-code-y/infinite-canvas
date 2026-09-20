import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ProviderCatalogEntry } from "../../lib/backend";
import { defaultModelOperationSchema } from "../../lib/modelCapabilities";
import { KnowledgeVideoWorkflowNode } from "./KnowledgeVideoWorkflowNode";
import { createAiFilmCheckpoint, createAiFilmWorkflowOptions } from "./aiFilmWorkflowModel";
import { createRemotionCheckpoint, createRemotionOptions } from "./remotionWorkflowModel";
import {
  createKnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowCheckpoint,
  type KnowledgeVideoWorkflowConfig,
  type KnowledgeVideoWorkflowNodeData,
  type KnowledgeVideoWorkflowShot,
  type NodeModelSelections,
} from "./workspaceModel";

const catalog: readonly ProviderCatalogEntry[] = [
  {
    provider: {
      id: "project-provider",
      displayName: "项目供应商",
      adapterId: "moyu_v1",
      baseUrl: "https://project.example/v1",
      apiKeyRef: "project-key",
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
        definitionId: "project-image-edit-only",
        remoteModelId: "project-image-edit-only",
        displayName: "仅图片编辑模型",
        operations: ["image_to_image"],
        operationSchema: defaultModelOperationSchema("project-image-edit-only", ["image_to_image"]),
      },
      {
        definitionId: "project-video",
        remoteModelId: "project-video",
        displayName: "项目视频模型",
        operations: ["video_generation"],
        operationSchema: defaultModelOperationSchema("project-video", ["video_generation"]),
      },
    ],
  },
];

const selections: NodeModelSelections = {
  prompt: { providerId: "project-provider", modelDefinitionId: "project-text" },
  image: { providerId: "project-provider", modelDefinitionId: "project-image" },
  video: { providerId: "project-provider", modelDefinitionId: "project-video" },
};

function createNode(config?: KnowledgeVideoWorkflowConfig): KnowledgeVideoWorkflowNodeData {
  return {
    key: "knowledge-video-workflow-1",
    kind: "knowledge_video_workflow",
    x: 100,
    y: 120,
    config: config ?? createKnowledgeVideoWorkflowConfig(selections, true),
  };
}

function commonProps(node: KnowledgeVideoWorkflowNodeData) {
  return {
    node,
    providerCatalog: catalog,
    onChange: vi.fn(),
    onExecute: vi.fn(),
    onContinue: vi.fn(),
    onCancel: vi.fn(),
    onRemove: vi.fn(),
    onRevealResult: vi.fn(),
  };
}

describe("KnowledgeVideoWorkflowNode", () => {
  it("runs animation with only a text model and no film configuration or video generation stages", () => {
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const animationNode = createNode({
      ...base,
      brief: "提出问题 -> 尝试解决 -> 收集反馈",
      remotion: createRemotionOptions(),
      models: {
        ...base.models,
        image: { providerId: "", modelDefinitionId: "" },
        video: { providerId: "", modelDefinitionId: "" },
      },
    });
    const props = commonProps(animationNode);
    render(<KnowledgeVideoWorkflowNode {...props} />);
    expect(screen.getByText("动画逻辑图工作流")).toBeInTheDocument();
    expect(screen.getByLabelText("动画制作要求")).toHaveValue(animationNode.config.brief);
    expect(screen.queryByLabelText("图片生成模型")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("视频生成模型")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "查看执行计划" }));
    expect(props.onExecute).toHaveBeenCalledWith(animationNode.key);
  });

  it("uses animation progress and preserves restart controls after failure", () => {
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const animationNode = createNode({
      ...base,
      brief: "三步流程",
      remotion: createRemotionOptions(),
      checkpoint: {
        ...base.checkpoint,
        phase: "failed",
        lastActivePhase: "generating",
        error: "渲染中断",
        remotion: createRemotionCheckpoint(),
      },
    });
    const props = commonProps(animationNode);
    render(<KnowledgeVideoWorkflowNode {...props} />);
    expect(screen.getByRole("progressbar", { name: "动画制作进度" })).toBeInTheDocument();
    expect(screen.getByText("本地渲染")).toBeInTheDocument();
    expect(screen.queryByText("合成")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "按当前资料重新制作" }));
    expect(props.onExecute).toHaveBeenCalledWith(animationNode.key);
    fireEvent.click(screen.getByRole("button", { name: "重试当前步骤" }));
    expect(props.onContinue).toHaveBeenCalledWith(animationNode.key);
  });

  it("locks animation configuration for decisions and excludes GIF from the film result player", () => {
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const animationNode = createNode({
      ...base,
      brief: "内容占比",
      remotion: createRemotionOptions(),
      film: createAiFilmWorkflowOptions(),
      checkpoint: {
        ...base.checkpoint,
        phase: "awaiting_approval",
        finalPath: "C:\\animations\\result.gif",
        decision: {
          kind: "planning",
          question: "占比是否以已提供数值为准？",
          recommendation: "保留现有数值",
        },
        remotion: createRemotionCheckpoint(),
      },
    });
    const props = commonProps(animationNode);
    const { rerender } = render(<KnowledgeVideoWorkflowNode {...props} />);
    expect(screen.getByLabelText("动画制作要求")).toBeDisabled();
    expect(screen.getByLabelText("动画模板")).toBeDisabled();
    expect(screen.getByLabelText("策划与审核模型")).toBeDisabled();
    expect(screen.queryByText("AI影视工作流")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "采用推荐并继续" }));
    expect(props.onContinue).toHaveBeenCalledWith(animationNode.key, "保留现有数值");
    rerender(
      <KnowledgeVideoWorkflowNode
        {...props}
        node={{
          ...animationNode,
          config: {
            ...animationNode.config,
            checkpoint: { ...animationNode.config.checkpoint, phase: "done" },
          },
        }}
      />,
    );
    expect(screen.queryByText("完整成片已就绪")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "最终交付物" })).not.toBeInTheDocument();
  });
  it("presents film source material and document delivery in the same node", () => {
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    function Harness() {
      const [config, setConfig] = useState({
        ...base,
        brief: "只做表演设计",
        film: createAiFilmWorkflowOptions(),
      } as KnowledgeVideoWorkflowConfig);
      return (
        <KnowledgeVideoWorkflowNode {...commonProps(createNode(config))} onChange={setConfig} />
      );
    }
    render(<Harness />);
    expect(screen.getByText("AI影视工作流")).toBeInTheDocument();
    fireEvent.click(screen.getByText("已有资料与制作范围"));
    fireEvent.change(screen.getByLabelText("影视已有资料"), {
      target: { value: "父亲合上怀表，女儿进门" },
    });
    fireEvent.change(screen.getByLabelText("影视起始阶段"), { target: { value: "acting" } });
    fireEvent.change(screen.getByLabelText("影视交付方式"), { target: { value: "documents" } });
    expect(screen.getByLabelText("影视已有资料")).toHaveValue("父亲合上怀表，女儿进门");
    expect(screen.getByLabelText("影视起始阶段")).toHaveValue("acting");
    expect(screen.getByRole("button", { name: "查看执行计划" })).toBeEnabled();
  });

  it("shows versioned film documents even when no movie was requested", () => {
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const source = createNode({
      ...base,
      film: { ...createAiFilmWorkflowOptions(), deliverable: "documents" },
      checkpoint: {
        ...base.checkpoint,
        phase: "done",
        documentsOnly: true,
        film: {
          ...createAiFilmCheckpoint(),
          artifacts: [
            {
              stage: "screenplay",
              version: 2,
              content: "# 最新剧本正文",
              inputSummary: "用户指定剧本",
              createdAt: 1,
            },
          ],
          history: [
            {
              stage: "screenplay",
              version: 1,
              content: "旧版剧本",
              inputSummary: "初稿",
              createdAt: 0,
            },
          ],
        },
      },
    });
    const onExport = vi.fn();
    render(
      <KnowledgeVideoWorkflowNode {...commonProps(source)} onExportFilmDocuments={onExport} />,
    );
    expect(screen.getByRole("region", { name: "影视阶段交付物" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("完整剧本 · v2"));
    expect(screen.getByText("# 最新剧本正文")).toBeInTheDocument();
    expect(screen.getByText("历史版本（1）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出影视制作文档" }));
    expect(onExport).toHaveBeenCalledWith(source.key);
  });
  it("keeps the default view simple and starts after the brief is filled", () => {
    const onExecute = vi.fn();

    function Harness() {
      const [config, setConfig] = useState(createKnowledgeVideoWorkflowConfig(selections, true));
      return (
        <KnowledgeVideoWorkflowNode
          {...commonProps(createNode(config))}
          onChange={setConfig}
          onExecute={onExecute}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByText("一个节点自动完成策划、生成、质检与交付")).toBeInTheDocument();
    const modelDetails = screen.getByText("模型配置").closest("details");
    expect(modelDetails).not.toHaveAttribute("open");

    const start = screen.getByRole("button", { name: "查看执行计划" });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "知识视频制作要求" }), {
      target: { value: "面向新员工制作一条 60 秒的 RAG 入门视频" },
    });
    expect(start).toBeEnabled();

    fireEvent.click(start);
    expect(onExecute).toHaveBeenCalledWith("knowledge-video-workflow-1");
  });

  it("shows only project models in the collapsed model configuration", () => {
    render(<KnowledgeVideoWorkflowNode {...commonProps(createNode())} />);

    fireEvent.click(screen.getByText("模型配置"));
    expect(document.querySelectorAll(".canvas-knowledge-workflow__model-slot")).toHaveLength(3);
    expect(screen.getByRole("combobox", { name: "策划与审核供应商" })).toHaveValue(
      "project-provider",
    );
    expect(screen.getByRole("combobox", { name: "图片生成模型" })).toHaveValue("project-image");
    expect(screen.getByRole("combobox", { name: "视频生成模型" })).toHaveValue("project-video");
    expect(screen.queryByRole("option", { name: "仅图片编辑模型" })).not.toBeInTheDocument();
    expect(screen.getByText("这里仅显示当前项目中已启用的供应商和模型。")).toBeInTheDocument();
  });

  it("shows compact progress and pauses only the following steps", () => {
    const onCancel = vi.fn();
    render(
      <KnowledgeVideoWorkflowNode
        {...commonProps(createNode())}
        runState={{
          phase: "generating",
          progress: 58,
          message: "正在生成第 3 个镜头",
          error: null,
        }}
        onCancel={onCancel}
      />,
    );

    expect(
      Number(
        screen.getByRole("progressbar", { name: "知识视频制作进度" }).getAttribute("aria-valuenow"),
      ),
    ).toBe(58);
    expect(screen.getByText("正在生成第 3 个镜头")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("生成");

    fireEvent.click(screen.getByRole("button", { name: "暂停后续步骤" }));
    expect(onCancel).toHaveBeenCalledWith("knowledge-video-workflow-1");
  });

  it("keeps the interrupted stage visible after a saved pause", () => {
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const pausedNode = createNode({
      ...base,
      checkpoint: {
        ...base.checkpoint,
        phase: "paused",
        lastActivePhase: "generating",
        error: "已暂停",
      },
    });
    render(<KnowledgeVideoWorkflowNode {...commonProps(pausedNode)} />);

    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("生成");
    expect(
      Number(
        screen.getByRole("progressbar", { name: "知识视频制作进度" }).getAttribute("aria-valuenow"),
      ),
    ).toBe(52);
  });

  it("accepts either the planning recommendation or a short customer answer", () => {
    const onContinue = vi.fn();
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const node = createNode({
      ...base,
      checkpoint: {
        ...base.checkpoint,
        phase: "awaiting_approval",
        decision: {
          kind: "planning",
          question: "更适合面向管理者还是一线员工？",
          recommendation: "建议先面向一线员工，减少术语并增加现场示例。",
        },
      },
    });

    render(<KnowledgeVideoWorkflowNode {...commonProps(node)} onContinue={onContinue} />);

    const decision = screen.getByRole("region", { name: "需要确认" });
    expect(within(decision).getByText("更适合面向管理者还是一线员工？")).toBeInTheDocument();
    fireEvent.click(within(decision).getByRole("button", { name: "采用推荐并继续" }));
    expect(onContinue).toHaveBeenCalledWith(
      "knowledge-video-workflow-1",
      "建议先面向一线员工，减少术语并增加现场示例。",
    );

    fireEvent.change(within(decision).getByRole("textbox", { name: "你的回答（可选）" }), {
      target: { value: "面向管理者，强调决策价值" },
    });
    fireEvent.click(within(decision).getByRole("button", { name: "确认并继续" }));
    expect(onContinue).toHaveBeenLastCalledWith(
      "knowledge-video-workflow-1",
      "面向管理者，强调决策价值",
    );
  });

  it("keeps QC decisions to confirming the current generated result", () => {
    const onContinue = vi.fn();
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const node = createNode({
      ...base,
      checkpoint: {
        ...base.checkpoint,
        phase: "awaiting_approval",
        decision: {
          kind: "qc",
          question: "镜头 3 的人物手部有轻微形变，是否继续使用？",
          recommendation: "当前问题不影响知识表达，建议采用并继续合成。",
        },
      },
    });

    render(<KnowledgeVideoWorkflowNode {...commonProps(node)} onContinue={onContinue} />);

    const decision = screen.getByRole("region", { name: "需要确认" });
    expect(within(decision).queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(within(decision).getByRole("button", { name: "采用当前结果并继续" }));
    expect(onContinue).toHaveBeenCalledWith("knowledge-video-workflow-1");
  });

  it("keeps the final movie and supporting deliverables inside the node", () => {
    const onRevealResult = vi.fn();
    const onExecute = vi.fn();
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const node = createNode({
      ...base,
      brief: "RAG 入门视频",
      checkpoint: {
        ...base.checkpoint,
        phase: "done",
        script: "# RAG 讲述脚本",
        storyboard: "# RAG 六段式分镜",
        shots: [
          {
            id: "shot-01",
            sequence: 1,
            section: "HOOK",
            track: "METAPHOR",
            title: "开场",
            durationSeconds: 5,
            visual: "检索抽屉",
            narration: "先找到资料，再组织答案。",
            videoPrompt: "稳定的检索抽屉动画",
            acceptance: "主体清晰",
          },
        ],
        shotRuns: {
          "shot-01": {
            shotId: "shot-01",
            qcStatus: "passed",
            qcReport: "五点画面一致",
            retryCount: 0,
          },
        },
        finalPath: "C:\\deliverables\\rag-intro.mp4",
      },
    });

    render(
      <KnowledgeVideoWorkflowNode
        {...commonProps(node)}
        onRevealResult={onRevealResult}
        onExecute={onExecute}
      />,
    );

    expect(screen.getByRole("region", { name: "最终交付物" })).toBeInTheDocument();
    expect(screen.getByText("完整成片已就绪")).toBeInTheDocument();
    fireEvent.click(screen.getByText("查看脚本、分镜与质检记录"));
    expect(screen.getByText("# RAG 讲述脚本")).toBeInTheDocument();
    expect(screen.getByText("# RAG 六段式分镜")).toBeInTheDocument();
    expect(screen.getByText("五点画面一致")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看成片" }));
    expect(onRevealResult).toHaveBeenCalledWith("knowledge-video-workflow-1");
    fireEvent.click(screen.getByRole("button", { name: "规划新一版" }));
    expect(onExecute).toHaveBeenCalledWith("knowledge-video-workflow-1");
  });

  it("lists generated shot clips and redoes a single shot through onRedoShot", () => {
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const shotFixture = (
      id: string,
      sequence: number,
      section: string,
    ): KnowledgeVideoWorkflowShot => ({
      id,
      sequence,
      section: section as KnowledgeVideoWorkflowShot["section"],
      track: "LECTURER",
      title: `镜头 ${sequence}`,
      durationSeconds: 5,
      visual: "",
      narration: "",
      videoPrompt: `prompt-${id}`,
      acceptance: "",
    });
    const checkpoint: KnowledgeVideoWorkflowCheckpoint = {
      ...base.checkpoint,
      phase: "done",
      shots: [shotFixture("shot-a", 1, "HOOK"), shotFixture("shot-b", 2, "CONCEPT")],
      shotRuns: {
        "shot-a": {
          shotId: "shot-a",
          videoTaskId: "task-a",
          clipPath: "C:\\output\\shot-a.mp4",
          qcStatus: "passed",
          retryCount: 0,
        },
        "shot-b": {
          shotId: "shot-b",
          videoTaskId: "task-b",
          clipPath: "C:\\output\\shot-b.mp4",
          qcStatus: "passed",
          retryCount: 0,
        },
      },
      finalPath: "C:\\output\\final.mp4",
    };
    const node = createNode({ ...base, brief: "重做测试", checkpoint });
    const onRedoShot = vi.fn();
    render(<KnowledgeVideoWorkflowNode {...commonProps(node)} onRedoShot={onRedoShot} />);

    expect(screen.getByRole("region", { name: "分镜视频" })).toBeInTheDocument();
    expect(screen.getByLabelText("镜头 1 视频预览")).toBeInTheDocument();
    expect(screen.getByLabelText("镜头 2 视频预览")).toBeInTheDocument();
    const redoButtons = screen.getAllByRole("button", { name: "重做此镜头" });
    expect(redoButtons).toHaveLength(2);
    fireEvent.click(redoButtons[1]!);
    expect(onRedoShot).toHaveBeenCalledWith(node.key, "shot-b");
  });

  it("marks a re-done shot as pending without offering another redo while it has no clip", () => {
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const shotFixture = (
      id: string,
      sequence: number,
      section: string,
    ): KnowledgeVideoWorkflowShot => ({
      id,
      sequence,
      section: section as KnowledgeVideoWorkflowShot["section"],
      track: "LECTURER",
      title: `镜头 ${sequence}`,
      durationSeconds: 5,
      visual: "",
      narration: "",
      videoPrompt: `prompt-${id}`,
      acceptance: "",
    });
    const checkpoint: KnowledgeVideoWorkflowCheckpoint = {
      ...base.checkpoint,
      phase: "paused",
      lastActivePhase: "generating",
      shots: [shotFixture("shot-a", 1, "HOOK"), shotFixture("shot-b", 2, "CONCEPT")],
      shotRuns: {
        "shot-a": {
          shotId: "shot-a",
          videoTaskId: "task-a",
          clipPath: "C:\\output\\shot-a.mp4",
          qcStatus: "passed",
          retryCount: 0,
        },
        "shot-b": {
          shotId: "shot-b",
          videoTaskId: null,
          clipPath: null,
          redoRequested: true,
          qcStatus: "pending",
          retryCount: 0,
          supersededTaskIds: ["task-b"],
        },
      },
      finalPath: "C:\\output\\final.mp4",
    };
    const node = createNode({ ...base, brief: "重做测试", checkpoint });
    render(<KnowledgeVideoWorkflowNode {...commonProps(node)} onRedoShot={vi.fn()} />);

    expect(screen.getByRole("region", { name: "分镜视频" })).toBeInTheDocument();
    expect(screen.getByText("待重做")).toBeInTheDocument();
    const redoButtons = screen.getAllByRole("button", { name: "重做此镜头" });
    expect(redoButtons).toHaveLength(1);
  });

  it("edits a shot's prompt and narration, saves it, and marks the shot as prompt-edited", () => {
    const base = createKnowledgeVideoWorkflowConfig(selections, true);
    const shotFixture = (
      id: string,
      sequence: number,
      section: string,
    ): KnowledgeVideoWorkflowShot => ({
      id,
      sequence,
      section: section as KnowledgeVideoWorkflowShot["section"],
      track: "LECTURER",
      title: `镜头 ${sequence}`,
      durationSeconds: 5,
      visual: "原画面描述",
      narration: "原旁白",
      videoPrompt: "原视频提示词",
      acceptance: "",
    });
    const checkpoint: KnowledgeVideoWorkflowCheckpoint = {
      ...base.checkpoint,
      phase: "done",
      shots: [shotFixture("shot-a", 1, "HOOK")],
      shotRuns: {
        "shot-a": {
          shotId: "shot-a",
          videoTaskId: "task-a",
          clipPath: "C:\\output\\shot-a.mp4",
          qcStatus: "passed",
          retryCount: 0,
        },
      },
      finalPath: "C:\\output\\final.mp4",
    };
    const node = createNode({ ...base, brief: "编辑测试", checkpoint });
    const onChange = vi.fn();
    render(
      <KnowledgeVideoWorkflowNode
        {...commonProps(node)}
        onChange={onChange}
        onRedoShot={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑分镜" }));
    expect(screen.getByLabelText("视频提示词")).toBeInTheDocument();
    expect(screen.getByLabelText("分镜画面描述")).toBeInTheDocument();
    expect(screen.getByLabelText("旁白台词")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("视频提示词"), {
      target: { value: "修改后的视频提示词" },
    });
    fireEvent.change(screen.getByLabelText("旁白台词"), {
      target: { value: "修改后的旁白" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedConfig = onChange.mock.calls[0]![0] as KnowledgeVideoWorkflowConfig;
    expect(updatedConfig.checkpoint.shots[0]?.videoPrompt).toBe("修改后的视频提示词");
    expect(updatedConfig.checkpoint.shots[0]?.narration).toBe("修改后的旁白");
    expect(updatedConfig.checkpoint.shotRuns["shot-a"]?.promptEdited).toBe(true);
  });
});
